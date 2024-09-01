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
import { StatusBar } from "./status";


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

  /** Folder to save highlights */
  readwiseDir: string;

  /** Polling for pending export */
  isSyncing: boolean;

  /** Frequency of automatic sync */
  frequency: string;

  /** Automatically sync on load */
  triggerOnLoad: boolean;

  lastSyncFailed: boolean;
  lastSavedStatusID: number;
  currentSyncStatusID: number;

  /** Should get any deleted books */
  refreshBooks: boolean,

  /** Queue of books to refresh */
  booksToRefresh: Array<string>;

  /** Map of file path to book ID */
  booksIDsMap: { [filePath: string]: string; };

  /** User choice for confirming delete and reimport */
  reimportShowConfirmation: boolean;
}

// define our initial settings
// quoted keys for easy copying to data.json during development
const DEFAULT_SETTINGS: ReadwisePluginSettings = {
  "token": "",
  "readwiseDir": "Readwise",
  "frequency": "0",
  "triggerOnLoad": true,
  "isSyncing": false,
  "lastSyncFailed": false,
  "lastSavedStatusID": 0,
  "currentSyncStatusID": 0,
  "refreshBooks": false,
  "booksToRefresh": [],
  "booksIDsMap": {},
  "reimportShowConfirmation": true
};

/** The name of the Readwise Sync history file, without the extension. */
const READWISE_SYNC_FILENAME = "Readwise Sync" as const;

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

  async handleSyncError(buttonContext: ButtonComponent, msg: string) {
    await this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = true;
    await this.saveSettings();
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentElement, msg, "rw-error");
      buttonContext.buttonEl.setText("Run sync");
    } else {
      this.notice(msg, true, 4, true);
    }
  }

  async clearSettingsAfterRun() {
    this.settings.isSyncing = false;
    this.settings.currentSyncStatusID = 0;
    await this.saveSettings();
  }

  async handleSyncSuccess(buttonContext: ButtonComponent, msg: string = "Synced", exportID: number = null) {
    await this.clearSettingsAfterRun();
    this.settings.lastSyncFailed = false;
    if (exportID) {
      this.settings.lastSavedStatusID = exportID;
    }
    await this.saveSettings();
    // if we have a button context, update the text on it
    // this is the case if we fired on a "Run sync" click (the button)
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentNode.parentElement, msg, "rw-success");
      buttonContext.buttonEl.setText("Run sync");
    }
  }

  /** Polls the Readwise API for the status of a given export;
   * uses recursion for polling so that it can be awaited. */
  async getExportStatus(statusID: number, buttonContext?: ButtonComponent) {
    try {
      const response = await fetch(
        `${baseURL}/api/get_export_status?exportStatusId=${statusID}`,
        {
          headers: this.getAuthHeaders(),
        }
      );

      if (response && response.ok) {
        const data: ExportStatusResponse = await response.json();

        const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY'];
        const SUCCESS_STATUSES = ['SUCCESS'];

        if (WAITING_STATUSES.includes(data.taskStatus)) {
          if (data.booksExported) {
            const progressMsg = `Exporting Readwise data (${data.booksExported} / ${data.totalBooks}) ...`;
            this.notice(progressMsg);
          } else {
            this.notice("Building export...");
          }

          // wait 1 second
          await new Promise(resolve => setTimeout(resolve, 1000));
          // then keep polling
          await this.getExportStatus(statusID, buttonContext);
        } else if (SUCCESS_STATUSES.includes(data.taskStatus)) {
          await this.downloadExport(statusID, buttonContext);
        } else {
          console.log("Readwise Official plugin: unknown status in getExportStatus: ", data);
          await this.handleSyncError(buttonContext, "Sync failed");
          return;
        }
      } else {
        console.log("Readwise Official plugin: bad response in getExportStatus: ", response);
        await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      }
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in getExportStatus: ", e);
      await this.handleSyncError(buttonContext, "Sync failed");
    }
  }

  /** Requests the archive from Readwise, polling until it's ready */
  async queueExport(buttonContext?: ButtonComponent, statusId?: number, auto?: boolean) {
    if (this.settings.isSyncing) {
      this.notice("Readwise sync already in progress", true);
      return;
    }

    console.log('Readwise Official plugin: requesting archive...');
    this.settings.isSyncing = true;
    await this.saveSettings();

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
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in queueExport: ", e);
    }

    if (response && response.ok) {
      data = await response.json();

      if (data.latest_id <= this.settings.lastSavedStatusID) {
        await this.handleSyncSuccess(buttonContext);
        this.notice("Readwise data is already up to date", false, 4, true);
        return;
      }

      // save the sync status ID so it can be polled until the archive is ready
      this.settings.currentSyncStatusID = data.latest_id;
      await this.saveSettings();
      console.log("Readwise Official plugin: saved currentSyncStatusID", this.settings.currentSyncStatusID);

      if (response.status === 201) {
        this.notice("Syncing Readwise data");
        await this.getExportStatus(this.settings.currentSyncStatusID, buttonContext);
        console.log('Readwise Official plugin: queueExport done');
      } else {
        await this.handleSyncSuccess(buttonContext, "Synced", data.latest_id);
        this.notice("Latest Readwise sync already happened on your other device. Data should be up to date", false, 4, true);
      }
    } else {
      console.log("Readwise Official plugin: bad response in queueExport: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
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

  async downloadExport(exportID: number, buttonContext: ButtonComponent): Promise<void> {
    let artifactURL = `${baseURL}/api/download_artifact/${exportID}`;
    if (exportID <= this.settings.lastSavedStatusID) {
      console.log(`Readwise Official plugin: Already saved data from export ${exportID}`);
      await this.handleSyncSuccess(buttonContext);
      this.notice("Readwise data is already up to date", false, 4);
      return;
    }

    let response, blob;
    try {
      response = await fetch(
        artifactURL, { headers: this.getAuthHeaders() }
      );
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in downloadExport: ", e);
    }
    if (response && response.ok) {
      blob = await response.blob();
    } else {
      console.log("Readwise Official plugin: bad response in downloadExport: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
      return;
    }

    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();
    this.notice("Saving files...", false, 30);
    if (entries.length) {
      for (const entry of entries) {
        // will be derived from the entry's filename
        let bookID: string;

        /** Combo of file `readwiseDir`, book name, and book ID.
         * Example: `Readwise/Books/Name of Book--12345678.md` */
        const processedFileName = normalizePath(entry.filename.replace(/^Readwise/, this.settings.readwiseDir));

        // derive the original name `(readwiseDir + book name).md`
        let originalName = processedFileName;
        // extracting book ID from file name
        let split = processedFileName.split("--");
        if (split.length > 1) {
          originalName = split.slice(0, -1).join("--") + ".md";
          bookID = split.last().match(/\d+/g)[0];

          // track the book
          this.settings.booksIDsMap[originalName] = bookID;
        }

        try {
          const undefinedBook = !bookID || !processedFileName;
          const isReadwiseSyncFile = processedFileName === `${this.settings.readwiseDir}/${READWISE_SYNC_FILENAME}.md`;
          if (undefinedBook && !isReadwiseSyncFile) {
            throw new Error(`Book ID or file name not found for entry: ${entry.filename}`);
          }
        } catch (e) {
          console.error(`Error while processing entry: ${entry.filename}`);
        }

        // save the entry in settings to ensure that it can be
        // retried later when deleted files are re-synced if
        // the user has `settings.refreshBooks` enabled
        if (bookID) await this.saveSettings();

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

          if (await this.fs.exists(originalName)) {
            // if the file already exists we need to append content to existing one
            const existingContent = await this.fs.read(originalName);
            contentToSave = existingContent + contents;
          }
          await this.fs.write(originalName, contentToSave);
          await this.removeBooksFromRefresh([bookID]);
          await this.saveSettings();
        } catch (e) {
          console.log(`Readwise Official plugin: error writing ${processedFileName}:`, e);
          this.notice(`Readwise: error while writing ${processedFileName}: ${e}`, true, 4, true);
          if (bookID) {
            // handles case where user doesn't have `settings.refreshBooks` enabled
            await this.addBookToRefresh(bookID);
          }
          // communicate with readwise?
        }
      }
    }
    // close the ZipReader
    await zipReader.close();
    await this.acknowledgeSyncCompleted(buttonContext);
    await this.handleSyncSuccess(buttonContext, "Synced!", exportID);
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
          headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
          method: "POST",
        });
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed to acknowledged sync: ", e);
    }
    if (response && response.ok) {
      return;
    } else {
      console.log("Readwise Official plugin: bad response in acknowledge sync: ", response);
      await this.handleSyncError(buttonContext, this.getErrorMessageFromResponse(response));
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
      // user set frequency to manual
      return;
    }
    this.scheduleInterval = window.setInterval(() => this.syncBookHighlights(undefined, true), milliseconds);
    this.registerInterval(this.scheduleInterval);
  }

  /** Syncs provided book IDs, or uses the booksToRefresh list if none provided.
   * ALL syncing starts with this function. */
  async syncBookHighlights(
    /** optional list of specific book IDs to sync */
    bookIds?: Array<string>,

    /** if true, was not initiated by user */
    auto?: boolean,
  ) {
    if (!this.settings.token) return;

    const targetBookIds = bookIds || this.settings.booksToRefresh;

    // add potentially-missing books to booksToRefresh (TODO - prob a lil inefficient? 🤷)
    const knownFilesPaths = Object.keys(this.settings.booksIDsMap);
    const shouldGetMissingBooks = this.settings.refreshBooks && !bookIds?.length;
    if (shouldGetMissingBooks) {
      for (const knownFilePath of knownFilesPaths) {
        const file = this.app.vault.getAbstractFileByPath(knownFilePath);
        if (!file) {
          const bookId = this.settings.booksIDsMap[knownFilePath];
          targetBookIds.push(bookId);
        }
      }
    }

    const hasNeverSynced = !knownFilesPaths.length;
    if (hasNeverSynced) {
      this.notice("Preparing initial Readwise sync...", true);
      await this.queueExport();
      return;
    }

    if (!targetBookIds.length) {
      console.log('Readwise Official plugin: no targetBookIds, triggering check for other updates...');
      await this.queueExport(null, null, auto);
      return;
    }

    console.log('Readwise Official plugin: refreshing books', { targetBookIds });

    try {
      const response = await fetch(
        `${baseURL}/api/refresh_book_export`,
        {
          headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
          method: "POST",
          body: JSON.stringify({ exportTarget: 'obsidian', books: targetBookIds })
        }
      );

      if (response && response.ok) {
        await this.queueExport();
        return;
      } else {
        console.log(`Readwise Official plugin: saving book id ${bookIds} to refresh later`);
        const deduplicatedBookIds = new Set([...this.settings.booksToRefresh, ...bookIds]);
        this.settings.booksToRefresh = Array.from(deduplicatedBookIds);
        await this.saveSettings();
        return;
      }
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in syncBookHighlights: ", e);
    }
  }

  async addBookToRefresh(bookId: string) {
    let booksToRefresh = this.settings.booksToRefresh;
    booksToRefresh.push(bookId);
    console.log(`Readwise Official plugin: added book id ${bookId} to refresh later`);
    this.settings.booksToRefresh = booksToRefresh;
    await this.saveSettings();
  }

  async removeBooksFromRefresh(bookIds: Array<string> = []) {
    if (!bookIds.length) return;

    console.log(`Readwise Official plugin: removing book ids ${bookIds.join(', ')} from refresh list`);
    this.settings.booksToRefresh = this.settings.booksToRefresh.filter(n => !bookIds.includes(n));
    await this.saveSettings();
  }

  async reimportFile(vault: Vault, fileName: string) {
    try {
      this.notice("Deleting and reimporting file...", true);
      await vault.delete(vault.getAbstractFileByPath(fileName));
      const bookId = this.settings.booksIDsMap[fileName];
      await this.syncBookHighlights([bookId]);
    } catch (e) {
      console.log("Readwise Official plugin: fetch failed in Reimport current file: ", e);
    }
  }

  async onload() {
    await this.loadSettings();

    // @ts-expect-error - no type for isMobile
    if (!this.app.isMobile) {
      this.statusBar = new StatusBar(this.addStatusBarItem());
      this.registerInterval(
        window.setInterval(() => this.statusBar.display(), 1000)
      );
    }

    this.app.vault.on("rename", async (file, oldPath) => {
      const bookId = this.settings.booksIDsMap[oldPath];
      if (!bookId) {
        return;
      }
      delete this.settings.booksIDsMap[oldPath];
      this.settings.booksIDsMap[file.path] = bookId;
      await this.saveSettings();
    });
    this.addCommand({
      id: 'readwise-official-sync',
      name: 'Sync your data now',
      callback: () => {
        this.syncBookHighlights();
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
          const buttonsContainer = modal.contentEl.createEl('div', { "cls": "rw-modal-btns" });
          const cancelBtn = buttonsContainer.createEl("button", { "text": "Cancel" });
          const confirmBtn = buttonsContainer.createEl("button", { "text": "Proceed", 'cls': 'mod-warning' });
          const showConfContainer = modal.contentEl.createEl('div', { 'cls': 'rw-modal-confirmation' });
          showConfContainer.createEl("label", { "attr": { "for": "rw-ask-nl" }, "text": "Don't ask me in the future" });
          const showConf = showConfContainer.createEl("input", { "type": "checkbox", "attr": { "name": "rw-ask-nl", "id": "rw-ask-nl" } });
          showConf.addEventListener('change', async (ev) => {
            // @ts-expect-error - target.checked is not typed (TODO add type narrowing)
            this.settings.reimportShowConfirmation = !ev.target.checked;
            await this.saveSettings();
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

    // ensure workspace is settled; this ensures cache is loaded
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.isSyncing && this.settings.currentSyncStatusID) {
        await this.getExportStatus(this.settings.currentSyncStatusID);
      } else {
        // we probably got some unhandled error...
        this.settings.isSyncing = false;
        await this.saveSettings();
      }

      if (this.settings.triggerOnLoad) {
        await this.syncBookHighlights(undefined, true);
      }

      await this.configureSchedule();
    });
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
      console.log("Readwise Official plugin: successfully authenticated with Readwise");
      this.settings.token = data.userAccessToken;
      await this.saveSettings();
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
    let { containerEl } = this;

    containerEl.empty();
    containerEl.createEl('h1', { text: 'Readwise Official' });
    containerEl.createEl('p', { text: 'Created by ' }).createEl('a', { text: 'Readwise', href: 'https://readwise.io' });
    containerEl.getElementsByTagName('p')[0].appendText(' 📚');
    containerEl.createEl('h2', { text: 'Settings' });

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
                await this.plugin.syncBookHighlights();
              }
            });
        });
      let el = containerEl.createEl("div", { cls: "rw-info-container" });
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

          dropdown.onChange(async (newValue) => {
            // update the plugin settings
            this.plugin.settings.frequency = newValue;
            await this.plugin.saveSettings();

            // destroy & re-create the scheduled task
            this.plugin.configureSchedule();
          });
        });
      new Setting(containerEl)
        .setName("Sync automatically when Obsidian opens")
        .setDesc("If enabled, Readwise will automatically resync with Obsidian each time you open the app")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.triggerOnLoad);
          toggle.onChange(async (val) => {
            this.plugin.settings.triggerOnLoad = val;
            await this.plugin.saveSettings();
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
              await this.plugin.syncBookHighlights();
            }
          });
        }
        );

      if (this.plugin.settings.lastSyncFailed) {
        this.plugin.showInfoStatus(containerEl.find(".rw-setting-sync .rw-info-container").parentElement, "Last sync failed", "rw-error");
      }
    } else {
      new Setting(containerEl)
        .setName("Connect Obsidian to Readwise")
        .setClass("rw-setting-connect")
        .setDesc("The Readwise plugin enables automatic syncing of all your highlights from Kindle, Instapaper, Pocket, and more. Note: Requires Readwise account.")
        .addButton((button) => {
          button.setButtonText("Connect").setCta().onClick(async (evt) => {
            const success = await this.plugin.getUserAuthToken(evt.target as HTMLElement);
            if (success) {
              // re-render the settings
              this.display();

              this.plugin.notice("Readwise connected", true);
            }
          });
        });
      let el = containerEl.createEl("div", { cls: "rw-info-container" });
      containerEl.find(".rw-setting-connect > .setting-item-control ").prepend(el);
    }
    const help = containerEl.createEl('p',);
    help.innerHTML = "Question? Please see our <a href='https://help.readwise.io/article/125-how-does-the-readwise-to-obsidian-export-integration-work'>Documentation</a> or email us at <a href='mailto:hello@readwise.io'>hello@readwise.io</a> 🙂";
  }
}
