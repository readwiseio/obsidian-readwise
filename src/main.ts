import {
  App,
  ButtonComponent,
  DataAdapter,
  Modal,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Vault
} from 'obsidian';
import * as zip from "@zip.js/zip.js";
import {StatusBar} from "./status";


// the process.env variable will be replaced by its target value in the output main.js file
const baseURL = process.env.READWISE_SERVER_URL || "https://readwise.io";

interface ReadwiseAuthResponse {
  userAccessToken: string;
}

interface ExportRequestResponse {
  latest_id: number,
  status: string
}

interface ExportStatusResponse {
  totalBooks: number,
  booksExported: number,
  isFinished: boolean,
  taskStatus: string,
}

interface ReadwisePluginSettings {
  token: string;
  readwiseDir: string;
  isSyncing: boolean;
  frequency: string;
  triggerOnLoad: boolean;
  lastSyncFailed: boolean;
  lastSavedStatusID: number;
  currentSyncStatusID: number;
  refreshBooks: boolean,
  booksToRefresh: Array<string>;
  booksIDsMap: { [key: string]: string; };
  reimportShowConfirmation: boolean;
}

// define our initial settings
const DEFAULT_SETTINGS: ReadwisePluginSettings = {
  token: "",
  readwiseDir: "Readwise",
  frequency: "0", // manual by default
  triggerOnLoad: true,
  isSyncing: false,
  lastSyncFailed: false,
  lastSavedStatusID: 0,
  currentSyncStatusID: 0,
  refreshBooks: false,
  booksToRefresh: [],
  booksIDsMap: {},
  reimportShowConfirmation: true,
};

export default class ReadwisePlugin extends Plugin {
  settings: ReadwisePluginSettings;
  fs: DataAdapter;
  vault: Vault;
  scheduleInterval: null | number = null;
  statusBar: StatusBar;

  getErrorMessageFromResponse(response: Response) {
    if (response && response.status === 409) {
      return "Sync in progress initiated by different client";
    }
    if (response && response.status === 417) {
      return "Obsidian export is locked. Wait for an hour.";
    }
    return `${response ? response.statusText : "Can't connect to server"}`;
  }

  handleSyncError(buttonContext: ButtonComponent, msg: string) {
    this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = true;
    this.saveSettings();
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentElement, msg, "rw-error");
      buttonContext.buttonEl.setText("Run sync");
    } else {
      this.notice(msg, true, 4, true);
    }
  }

  clearSettingsAfterRun() {
    this.settings.isSyncing = false;
    this.settings.currentSyncStatusID = 0;
  }

  handleSyncSuccess(buttonContext: ButtonComponent, msg: string = "Synced", exportID: number = null) {
    this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = false;
    this.settings.currentSyncStatusID = 0;
    if (exportID) {
      this.settings.lastSavedStatusID = exportID;
    }
    this.saveSettings();
    // if we have a button context, update the text on it
    // this is the case if we fired on a "Run sync" click (the button)
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentNode.parentElement, msg, "rw-success");
      buttonContext.buttonEl.setText("Run sync");
    }
  }

  async getExportStatus(statusID?: number, buttonContext?: ButtonComponent) {
    const statusId = statusID || this.settings.currentSyncStatusID;
    let url = `${baseURL}/api/get_export_status?exportStatusId=${statusId}`;
    let response, data: ExportStatusResponse;
    try {
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in getExportStatus: ", e);
    }
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("Readwise Official plugin: bad response in getExportStatus: ", response);
      this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
    const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY'];
    const SUCCESS_STATUSES = ['SUCCESS'];
    if (WAITING_STATUSES.includes(data.taskStatus)) {
      if (data.booksExported) {
        const progressMsg = `Exporting Readwise data (${data.booksExported} / ${data.totalBooks}) ...`;
        this.notice(progressMsg);
      } else {
        this.notice("Building export...");
      }

      // re-try in 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.getExportStatus(statusId, buttonContext);
    } else if (SUCCESS_STATUSES.includes(data.taskStatus)) {
      return this.downloadArchive(statusId, buttonContext);
    } else {
      this.handleSyncError(buttonContext, "Sync failed");
    }
  }

  /** Requests a new archive export from Readwise. Refreshes book exports along the way. */
  async requestArchive(buttonContext?: ButtonComponent, statusId?: number, auto?: boolean) {

    const parentDeleted = !await this.app.vault.adapter.exists(this.settings.readwiseDir);

    let url = `${baseURL}/api/obsidian/init?parentPageDeleted=${parentDeleted}`;
    if (statusId) {
      url += `&statusID=${statusId}`;
    }
    if (auto) {
      url += `&auto=${auto}`;
    }
    let response, data: ExportRequestResponse;
    try {
      await this.refreshBookExport();

      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in requestArchive: ", e);
    }
    if (response && response.ok) {
      data = await response.json();
      if (data.latest_id <= this.settings.lastSavedStatusID) {
        this.handleSyncSuccess(buttonContext);
        this.notice("Readwise data is already up to date", false, 4, true);
        return;
      }
      this.settings.currentSyncStatusID = data.latest_id;
      await this.saveSettings();
      if (response.status === 201) {
        this.notice("Syncing Readwise data");
        return this.getExportStatus(data.latest_id, buttonContext);
      } else {
        this.handleSyncSuccess(buttonContext, "Synced", data.latest_id); // we pass the export id to update lastSavedStatusID
        this.notice("Latest Readwise sync already happened on your other device. Data should be up to date", false, 4, true);
      }
    } else {
      console.log("Readwise Official plugin: bad response in requestArchive: ", response);
      this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
  }

  notice(msg: string, show = false, timeout = 0, forcing: boolean = false) {
    if (show) {
      new Notice(msg);
    }
    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar.displayMessage(msg.toLowerCase(), timeout, forcing);
    } else {
      if (!show) {
        new Notice(msg);
      }
    }
  }

  showInfoStatus(container: HTMLElement, msg: string, className = "") {
    let info = container.find('.rw-info-container');
    info.setText(msg);
    info.addClass(className);
  }

  clearInfoStatus(container: HTMLElement) {
    let info = container.find('.rw-info-container');
    info.empty();
  }

  getAuthHeaders() {
    return {
      'AUTHORIZATION': `Token ${this.settings.token}`,
      'Obsidian-Client': `${this.getObsidianClientID()}`,
    };
  }

  async downloadArchive(exportID: number, buttonContext: ButtonComponent): Promise<void> {
    let artifactURL = `${baseURL}/api/download_artifact/${exportID}`;
    if (exportID <= this.settings.lastSavedStatusID) {
      console.log(`Readwise Official plugin: Already saved data from export ${exportID}`);
      this.handleSyncSuccess(buttonContext);
      this.notice("Readwise data is already up to date", false, 4);
      return;
    }

    let response, blob;
    try {
      response = await fetch(
        artifactURL, {headers: this.getAuthHeaders()}
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in downloadArchive: ", e);
    }
    if (response && response.ok) {
      blob = await response.blob();
    } else {
      console.log("Readwise Official plugin: bad response in downloadArchive: ", response);
      this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }

    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();
    this.notice("Saving files...", false, 30);
    if (entries.length) {
      for (const entry of entries) {
        let bookID: string;
        const processedFileName = normalizePath(entry.filename.replace(/^Readwise/, this.settings.readwiseDir));
        try {
          // ensure the directory exists
          let dirPath = processedFileName.replace(/\/*$/, '').replace(/^(.+)\/[^\/]*?$/, '$1');
          const exists = await this.fs.exists(dirPath);
          if (!exists) {
            await this.fs.mkdir(dirPath);
          }
          // write the actual files
          const contents = await entry.getData(new zip.TextWriter());
          let contentToSave = contents;

          let originalName = processedFileName;
          // extracting book ID from file name
          let split = processedFileName.split("--");
          if (split.length > 1) {
            originalName = split.slice(0, -1).join("--") + ".md";
            bookID = split.last().match(/\d+/g)[0];
            this.settings.booksIDsMap[originalName] = bookID;
          }
          if (await this.fs.exists(originalName)) {
            // if the file already exists we need to append content to existing one
            const existingContent = await this.fs.read(originalName);
            contentToSave = existingContent + contents;
          }
          await this.fs.write(originalName, contentToSave);
          await this.saveSettings();
        } catch (e) {
          console.log(`Readwise Official plugin: error writing ${processedFileName}:`, e);
          this.notice(`Readwise: error while writing ${processedFileName}: ${e}`, true, 4, true);
          if (bookID) {
            this.settings.booksToRefresh.push(bookID);
            await this.saveSettings();
          }
          // communicate with readwise?
        }
      }
    }
    // close the ZipReader
    await zipReader.close();
    await this.acknowledgeSyncCompleted(buttonContext);
    this.handleSyncSuccess(buttonContext, "Synced!", exportID);
    this.notice("Readwise sync completed", true, 1, true);
    console.log("Readwise Official plugin: completed sync");
    // @ts-ignore
    if (this.app.isMobile) {
      this.notice("If you don't see all of your readwise files reload obsidian app", true,);
    }
  }

  async acknowledgeSyncCompleted(buttonContext: ButtonComponent) {
    let response;
    try {
      response = await fetch(
        `${baseURL}/api/obsidian/sync_ack`,
        {
          headers: {...this.getAuthHeaders(), 'Content-Type': 'application/json'},
          method: "POST",
        });
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed to acknowledged sync: ", e);
    }
    if (response && response.ok) {
      return;
    } else {
      console.log("Readwise Official plugin: bad response in acknowledge sync: ", response);
      this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }
  }

  async configureSchedule() {
    const minutes = parseInt(this.settings.frequency);
    let milliseconds = minutes * 60 * 1000; // minutes * seconds * milliseconds
    console.log('Readwise Official plugin: setting interval to ', milliseconds, 'milliseconds');
    window.clearInterval(this.scheduleInterval);
    this.scheduleInterval = null;
    if (!milliseconds) {
      // we got manual option
      return;
    }
    this.scheduleInterval = window.setInterval(() => this.requestArchive(null, null, true), milliseconds);
    this.registerInterval(this.scheduleInterval);
  }

  async refreshBookExport(bookIds?: Array<string>) {
    bookIds = bookIds || this.settings.booksToRefresh;
    if (!bookIds.length || !this.settings.refreshBooks) {
      return;
    }
    try {
      fetch(
        `${baseURL}/api/refresh_book_export`,
        {
          headers: {...this.getAuthHeaders(), 'Content-Type': 'application/json'},
          method: "POST",
          body: JSON.stringify({exportTarget: 'obsidian', books: bookIds})
        }
      ).then(response => {
        if (response && response.ok) {
          let booksToRefresh = this.settings.booksToRefresh;
          this.settings.booksToRefresh = booksToRefresh.filter(n => !bookIds.includes(n));
          this.saveSettings();
          return;
        } else {
          console.log(`Readwise Official plugin: saving book id ${bookIds} to refresh later`);
          let booksToRefresh = this.settings.booksToRefresh;
          booksToRefresh.concat(bookIds);
          this.settings.booksToRefresh = booksToRefresh;
          this.saveSettings();
          return;
        }
      });
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in refreshBookExport: ", e);
    }
  }

  async addBookToRefresh(bookId: string) {
    let booksToRefresh = this.settings.booksToRefresh;
    booksToRefresh.push(bookId);
    this.settings.booksToRefresh = booksToRefresh;
    await this.saveSettings();
  }

  reimportFile(vault: Vault, fileName: string) {
    const bookId = this.settings.booksIDsMap[fileName];
    try {
      fetch(
        `${baseURL}/api/refresh_book_export`,
        {
          headers: {...this.getAuthHeaders(), 'Content-Type': 'application/json'},
          method: "POST",
          body: JSON.stringify({exportTarget: 'obsidian', books: [bookId]})
        }
      ).then(response => {
        if (response && response.ok) {
          let booksToRefresh = this.settings.booksToRefresh;
          this.settings.booksToRefresh = booksToRefresh.filter(n => ![bookId].includes(n));
          this.saveSettings();
          vault.delete(vault.getAbstractFileByPath(fileName));
          this.startSync();
        } else {
          this.notice("Failed to reimport. Please try again", true);
        }
      });
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in Reimport current file: ", e);
    }
  }

  startSync() {
    if (this.settings.isSyncing) {
      this.notice("Readwise sync already in progress", true);
    } else {
      this.settings.isSyncing = true;
      this.saveSettings();
      this.requestArchive();
    }
    console.log("Readwise Official plugin: started sync");
  }

  async onload() {
    await this.loadSettings();

    // @ts-ignore
    if (!this.app.isMobile) {
      this.statusBar = new StatusBar(this.addStatusBarItem());
      this.registerInterval(
        window.setInterval(() => this.statusBar.display(), 1000)
      );
    }

    await this.refreshBookExport(this.settings.booksToRefresh);

    this.app.vault.on("delete", async (file) => {
      const bookId = this.settings.booksIDsMap[file.path];
      await this.addBookToRefresh(bookId);
      delete this.settings.booksIDsMap[file.path];
      await this.saveSettings();
    });
    this.app.vault.on("rename", (file, oldPath) => {
      const bookId = this.settings.booksIDsMap[oldPath];
      if (!bookId) {
        return;
      }
      this.settings.booksIDsMap[file.path] = bookId;
      delete this.settings.booksIDsMap[oldPath];
      this.saveSettings();
    });
    if (this.settings.isSyncing) {
      if (this.settings.currentSyncStatusID) {
        await this.getExportStatus();
      } else {
        // we probably got some unhandled error...
        this.settings.isSyncing = false;
        await this.saveSettings();
      }
    }
    this.addCommand({
      id: 'readwise-official-sync',
      name: 'Sync your data now',
      callback: () => {
        this.startSync();
      }
    });
    this.addCommand({
      id: 'readwise-official-format',
      name: 'Customize formatting',
      callback: () => window.open(`${baseURL}/export/obsidian/preferences`)
    });
    this.addCommand({
      id: 'readwise-official-reimport-file',
      name: 'Delete and reimport this document',
      checkCallback: (checking: boolean) => {
        const activeFilePath = this.app.workspace.getActiveFile()?.path;
        const isRWfile = activeFilePath && activeFilePath in this.settings.booksIDsMap;
        if (checking) {
          return isRWfile;
        }
        if (this.settings.reimportShowConfirmation) {
          const modal = new Modal(this.app);
          modal.titleEl.setText("Delete and reimport this document?");
          modal.contentEl.createEl(
            'p',
            {
              text: 'Warning: Proceeding will delete this file entirely (including any changes you made) ' +
                'and then reimport a new copy of your highlights from Readwise.',
              cls: 'rw-modal-warning-text',
            });
          const buttonsContainer = modal.contentEl.createEl('div', {"cls": "rw-modal-btns"});
          const cancelBtn = buttonsContainer.createEl("button", {"text": "Cancel"});
          const confirmBtn = buttonsContainer.createEl("button", {"text": "Proceed", 'cls': 'mod-warning'});
          const showConfContainer = modal.contentEl.createEl('div', {'cls': 'rw-modal-confirmation'});
          showConfContainer.createEl("label", {"attr": {"for": "rw-ask-nl"}, "text": "Don't ask me in the future"});
          const showConf = showConfContainer.createEl("input", {"type": "checkbox", "attr": {"name": "rw-ask-nl", "id": "rw-ask-nl"}});
          showConf.addEventListener('change', (ev) => {
            // @ts-ignore
            this.settings.reimportShowConfirmation = !ev.target.checked;
            this.saveSettings();
          });
          cancelBtn.onClickEvent(() => {
            modal.close();
          });
          confirmBtn.onClickEvent(() => {
            this.reimportFile(this.app.vault, activeFilePath);
            modal.close();
          });
          modal.open();
        } else {
          this.reimportFile(this.app.vault, activeFilePath);
        }
      }
    });
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!ctx.sourcePath.startsWith(this.settings.readwiseDir)) {
        return;
      }
      let matches: string[];
      try {
        // @ts-ignore
        matches = [...ctx.getSectionInfo(el).text.matchAll(/__(.+)__/g)].map((a) => a[1]);
      } catch (TypeError) {
        // failed interaction with a Dataview element
        return;
      }
      const hypers = el.findAll("strong").filter(e => matches.contains(e.textContent));
      hypers.forEach(strongEl => {
        const replacement = el.createEl('span');
        while (strongEl.firstChild) {
          replacement.appendChild(strongEl.firstChild);
        }
        replacement.addClass("rw-hyper-highlight");
        strongEl.replaceWith(replacement);
      });
    });
    this.addSettingTab(new ReadwiseSettingTab(this.app, this));
    await this.configureSchedule();
    if (this.settings.token && this.settings.triggerOnLoad && !this.settings.isSyncing) {
      await this.saveSettings();
      await this.requestArchive(null, null, true);
    }
  }

  onunload() {
    // we're not doing anything here for now...
    return;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getObsidianClientID() {
    let obsidianClientId = window.localStorage.getItem('rw-ObsidianClientId');
    if (obsidianClientId) {
      return obsidianClientId;
    } else {
      obsidianClientId = Math.random().toString(36).substring(2, 15);
      window.localStorage.setItem('rw-ObsidianClientId', obsidianClientId);
      return obsidianClientId;
    }
  }

  async getUserAuthToken(button: HTMLElement, attempt = 0) {
    let uuid = this.getObsidianClientID();

    if (attempt === 0) {
      window.open(`${baseURL}/api_auth?token=${uuid}&service=obsidian`);
    }

    let response, data: ReadwiseAuthResponse;
    try {
      response = await fetch(
        `${baseURL}/api/auth?token=${uuid}`
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in getUserAuthToken: ", e);
    }
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("Readwise Official plugin: bad response in getUserAuthToken: ", response);
      this.showInfoStatus(button.parentElement, "Authorization failed. Try again", "rw-error");
      return;
    }
    if (data.userAccessToken) {
      this.settings.token = data.userAccessToken;
    } else {
      if (attempt > 20) {
        console.log('Readwise Official plugin: reached attempt limit in getUserAuthToken');
        return;
      }
      console.log(`Readwise Official plugin: didn't get token data, retrying (attempt ${attempt + 1})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.getUserAuthToken(button, attempt + 1);
    }
    await this.saveSettings();
    return true;
  }
}

class ReadwiseSettingTab extends PluginSettingTab {
  plugin: ReadwisePlugin;

  constructor(app: App, plugin: ReadwisePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }


  display(): void {
    let {containerEl} = this;

    containerEl.empty();
    containerEl.createEl('h1', {text: 'Readwise Official'});
    containerEl.createEl('p', {text: 'Created by '}).createEl('a', {text: 'Readwise', href: 'https://readwise.io'});
    containerEl.getElementsByTagName('p')[0].appendText(' 📚');
    containerEl.createEl('h2', {text: 'Settings'});

    if (this.plugin.settings.token) {
      new Setting(containerEl)
        .setName("Sync your Readwise data with Obsidian")
        .setDesc("On first sync, the Readwise plugin will create a new folder containing all your highlights")
        .setClass('rw-setting-sync')
        .addButton((button) => {
          button.setCta().setTooltip("Once the sync begins, you can close this plugin page")
            .setButtonText('Initiate Sync')
            .onClick(async () => {
              if (this.plugin.settings.isSyncing) {
                // NOTE: This is used to prevent multiple syncs at the same time. However, if a previous sync fails,
                //  it can stop new syncs from happening. Make sure to set isSyncing to false
                //  if there's ever errors/failures in previous sync attempts, so that
                //  we don't block syncing subsequent times.
                new Notice("Readwise sync already in progress");
              } else {
                this.plugin.clearInfoStatus(containerEl);
                this.plugin.settings.isSyncing = true;
                await this.plugin.saveSettings();
                await this.plugin.requestArchive(button);
              }

            });
        });
      let el = containerEl.createEl("div", {cls: "rw-info-container"});
      containerEl.find(".rw-setting-sync > .setting-item-control ").prepend(el);

      new Setting(containerEl)
        .setName("Customize formatting options")
        .setDesc("You can customize which items export to Obsidian and how they appear from the Readwise website")
        .addButton((button) => {
          button.setButtonText("Customize").onClick(() => {
            window.open(`${baseURL}/export/obsidian/preferences`);
          });
        });

      new Setting(containerEl)
        .setName('Customize base folder')
        .setDesc("By default, the plugin will save all your highlights into a folder named Readwise")
        // TODO: change this to search filed when the API is exposed (https://github.com/obsidianmd/obsidian-api/issues/22)
        .addText(text => text
          .setPlaceholder('Defaults to: Readwise')
          .setValue(this.plugin.settings.readwiseDir)
          .onChange(async (value) => {
            this.plugin.settings.readwiseDir = normalizePath(value || "Readwise");
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('Configure resync frequency')
        .setDesc("If not set to Manual, Readwise will automatically resync with Obsidian when the app is open at the specified interval")
        .addDropdown(dropdown => {
          dropdown.addOption("0", "Manual");
          dropdown.addOption("60", "Every 1 hour");
          dropdown.addOption((12 * 60).toString(), "Every 12 hours");
          dropdown.addOption((24 * 60).toString(), "Every 24 hours");
          dropdown.addOption((7 * 24 * 60).toString(), "Every week");
        
          // select the currently-saved option
          dropdown.setValue(this.plugin.settings.frequency);

          dropdown.onChange((newValue) => {
            // update the plugin settings
            this.plugin.settings.frequency = newValue;
            this.plugin.saveSettings();

            // destroy & re-create the scheduled task
            this.plugin.configureSchedule();
          });
        });
      new Setting(containerEl)
        .setName("Sync automatically when Obsidian opens")
        .setDesc("If enabled, Readwise will automatically resync with Obsidian each time you open the app")
        .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.triggerOnLoad);
            toggle.onChange((val) => {
              this.plugin.settings.triggerOnLoad = val;
              this.plugin.saveSettings();
            });
          }
        );
      new Setting(containerEl)
        .setName("Resync deleted files")
        .setDesc("If enabled, you can refresh individual items by deleting the file in Obsidian and initiating a resync")
        .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.refreshBooks);
            toggle.onChange(async (val) => {
              this.plugin.settings.refreshBooks = val;
              await this.plugin.saveSettings();
              if (val) {
                await this.plugin.refreshBookExport();
              }
            });
          }
        );

      if (this.plugin.settings.lastSyncFailed) {
        this.plugin.showInfoStatus(containerEl.find(".rw-setting-sync .rw-info-container").parentElement, "Last sync failed", "rw-error");
      }
    }
    if (!this.plugin.settings.token) {
      new Setting(containerEl)
        .setName("Connect Obsidian to Readwise")
        .setClass("rw-setting-connect")
        .setDesc("The Readwise plugin enables automatic syncing of all your highlights from Kindle, Instapaper, Pocket, and more. Note: Requires Readwise account.")
        .addButton((button) => {
          button.setButtonText("Connect").setCta().onClick(async (evt) => {
            const success = await this.plugin.getUserAuthToken(evt.target as HTMLElement);
            if (success) {
              this.display();
            }
          });
        });
      let el = containerEl.createEl("div", {cls: "rw-info-container"});
      containerEl.find(".rw-setting-connect > .setting-item-control ").prepend(el);
    }
    const help = containerEl.createEl('p',);
    help.innerHTML = "Question? Please see our <a href='https://help.readwise.io/article/125-how-does-the-readwise-to-obsidian-export-integration-work'>Documentation</a> or email us at <a href='mailto:hello@readwise.io'>hello@readwise.io</a> 🙂";
  }
}
