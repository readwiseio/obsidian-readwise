import {
  App,
  ButtonComponent,
  DataAdapter,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  setIcon,
  Setting,
  Vault
} from 'obsidian';
import * as zip from "@zip.js/zip.js";


require('electron');

const path = require("path")


const baseURL = process.env.READWISE_SERVER_URL || "https://readwise.io"

interface ReadwiseAuthResponse extends JSON {
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
  obsidianToken: string;
  isSyncing: boolean;
  frequency: string;
  triggerOnLoad: boolean;
  lastSyncFailed: boolean;
  lastSavedStatusID: number;
  refreshBooks: boolean,
  booksToRefresh: Array<string>;
  booksIDsMap: { [key: string]: string; };
}

// define our initial settings
const DEFAULT_SETTINGS: ReadwisePluginSettings = {
  token: "",
  obsidianToken: "",
  frequency: "0", // manual by default
  triggerOnLoad: false,
  isSyncing: false,
  lastSyncFailed: false,
  lastSavedStatusID: 0,
  refreshBooks: true,
  booksToRefresh: [],
  booksIDsMap: {}
}

export default class ReadwisePlugin extends Plugin {
  settings: ReadwisePluginSettings;
  fs: DataAdapter;
  vault: Vault;

  handleSyncError(buttonContext: ButtonComponent, msg: string) {
    this.settings.isSyncing = false;
    this.settings.lastSyncFailed = true;
    this.saveData(this.settings);
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentElement, msg, "rw-error")
      buttonContext.buttonEl.setText("Run sync");
    }
  }

  handleSyncSuccess(buttonContext: ButtonComponent, msg: string = "Synced", exportID: number = null) {
    this.settings.isSyncing = false;
    this.settings.lastSyncFailed = false;
    if (exportID) {
      this.settings.lastSavedStatusID = exportID;
    }
    this.saveData(this.settings);
    // if we have a button context, update the text on it
    // this is the case if we fired on a "Run sync" click (the button)
    if (buttonContext) {
      this.showInfoStatus(buttonContext.buttonEl.parentNode.parentElement, msg, "rw-success")
      buttonContext.buttonEl.setText("Run sync");
    }
  }

  async getExportStatus(statusId: number, buttonContext?: ButtonComponent) {
    let url = `${baseURL}/api/get_export_status?exportStatusId=${statusId}`
    let response, data: ExportStatusResponse
    try {
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      )
    } catch (e) {
      console.log("ReadwisePlugin: fetch failed in getExportStatus: ", e)
    }
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("ReadwisePlugin: bad response in requestArchive: ", response)
      this.handleSyncError(buttonContext, response ? response.statusText : "Can't connect to server")
      return
    }
    const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY']
    const SUCCESS_STATUSES = ['SUCCESS']
    if (WAITING_STATUSES.includes(data.taskStatus)) {
      if (data.booksExported) {
        const progressMsg = `Exporting Readwise data (${data.booksExported} / ${data.totalBooks}) ...`
        new Notice(progressMsg);
      }
      // re-try in 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.getExportStatus(statusId, buttonContext);
    } else if (SUCCESS_STATUSES.includes(data.taskStatus)) {
      return this.downloadArchive(statusId, buttonContext);
    } else {
      this.handleSyncError(buttonContext, "Sync failed")
    }
  }

  async requestArchive(buttonContext?: ButtonComponent, statusId?: number) {

    const parentDeleted = !await this.app.vault.adapter.exists("Readwise")

    let url = `${baseURL}/api/obsidian/init?parentPageDeleted=${parentDeleted}`
    if (statusId) {
      url += `&statusID=${statusId}`
    }
    let response, data: ExportRequestResponse
    try {
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      )
    } catch (e) {
      console.log("ReadwisePlugin: fetch failed in requestArchive: ", e)
    }
    if (response && response.ok) {
      data = await response.json();
      if (data.latest_id <= this.settings.lastSavedStatusID) {
        this.handleSyncSuccess(buttonContext)
        new Notice("Readwise data is already up to date");
        return
      }
      new Notice("Readwise sync started");
      return this.getExportStatus(data.latest_id, buttonContext)
    } else {
      console.log("ReadwisePlugin: bad response in requestArchive: ", response)
      this.handleSyncError(buttonContext, response ? response.statusText : "Can't connect to server")
      return
    }
  }

  showInfoStatus(container: HTMLElement, msg: string, className = "") {
    let info = container.find('.rw-info')
    info.setText(msg)
    info.addClass(className)
  }

  clearInfoStatus(container: HTMLElement) {
    let info = container.find('.rw-info')
    info.innerHTML = "";
  }

  getAuthHeaders() {
    return {
      'AUTHORIZATION': `Token ${this.settings.token}`
    }
  }

  async downloadArchive(exportID: number, buttonContext: ButtonComponent): Promise<void> {
    let artifactURL = `${baseURL}/api/download_artifact/${exportID}`
    if (exportID <= this.settings.lastSavedStatusID) {
      console.log(`Already saved data from export ${exportID}`)
      this.handleSyncSuccess(buttonContext)
      new Notice("Readwise data is already up to date");
      return
    }

    let response, blob
    try {
      response = await fetch(
        artifactURL, {headers: this.getAuthHeaders()}
      )
    } catch (e) {
      console.log("ReadwisePlugin: fetch failed in downloadArchive: ", e)
    }
    if (response && response.ok) {
      blob = await response.blob();
    } else {
      console.log("ReadwisePlugin: bad response in downloadArchive: ", response)
      this.handleSyncError(buttonContext, response ? response.statusText : "Can't connect to server")
      return
    }

    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();
    new Notice("Saving files...");
    if (entries.length) {
      for (const entry of entries) {
        let bookID: string
        try {
          // ensure the directory exists
          let dirPath = path.dirname(entry.filename)
          const exists = await this.fs.exists(dirPath)
          if (!exists) {
            await this.fs.mkdir(dirPath);
          }
          // write the actual files
          const contents = await entry.getData(new zip.TextWriter())
          let contentToSave = contents
          let originalName = entry.filename

          // extracting book ID from file name
          let split = entry.filename.split("--")
          if (split.length > 1) {
            originalName = split.slice(0, -1).join("--") + ".md"
            bookID = split.last().match(/\d+/g)[0]
            this.settings.booksIDsMap[originalName] = bookID;
          }

          if (await this.fs.exists(originalName)) {
            // if the file already exists we need to append content to existing one
            const existingContent = await this.fs.read(originalName)
            contentToSave = existingContent + contents
          }
          await this.fs.write(originalName, contentToSave)
          await this.saveSettings()
        } catch (e) {
          console.log(`ReadwisePlugin: error writing ${entry.filename}:`,e)
          if (bookID) {
            this.settings.booksToRefresh.push(bookID)
            await this.saveSettings()
          }
          // communicate with readwise?
        }
      }
    }
    // close the ZipReader
    await zipReader.close();
    this.handleSyncSuccess(buttonContext, "Synced!", exportID)
    new Notice("Readwise sync completed");
  }


  async configureSchedule() {
    const minutes = parseInt(this.settings.frequency)
    let milliseconds = minutes * 60 * 1000; // minutes * seconds * milliseconds
    console.log('ReadwisePlugin: setting interval to ', milliseconds, 'milliseconds');
    window.clearInterval();
    if (!milliseconds) {
      // we got manual option
      return
    }
    this.registerInterval(
      window.setInterval(() => this.requestArchive(), milliseconds)
    );
  }

  async refreshBookExport(bookId: string) {
    let response
    let formData = new FormData();
    formData.append('userBookId', bookId);
    formData.append('exportTarget', 'obsidian');
    try {
      response = await fetch(
        `${baseURL}/api/refresh_book_export`,
        {
          headers: this.getAuthHeaders(),
          method: "POST",
          body: formData
        }
      )
    } catch (e) {
      console.log("ReadwisePlugin: fetch failed in refreshBookExport: ", e)
    }
    if (response && response.ok) {
      return
    } else {
      console.log(`ReadwisePlugin: saving book id ${bookId} to refresh later`)
      let booksToRefresh = this.settings.booksToRefresh
      booksToRefresh.push(bookId)
      this.settings.booksToRefresh = booksToRefresh
      await this.saveSettings()
      return
    }
  }

  async onload() {
    await this.loadSettings();
    let booksToRefresh = this.settings.booksToRefresh
    this.settings.booksToRefresh = []
    await this.saveSettings()
    booksToRefresh.forEach((bookID) => {
      this.refreshBookExport(bookID)
    })
    this.app.vault.on("delete", (file) => {
      const bookId = this.settings.booksIDsMap[file.path]
      if (this.settings.refreshBooks && bookId) {
        this.refreshBookExport(bookId)
      }
    })
    this.app.vault.on("rename", (file, oldPath) => {
      const bookId = this.settings.booksIDsMap[oldPath]
      if (!bookId) {
        return
      }
      this.settings.booksIDsMap[file.path] = bookId
      delete this.settings.booksIDsMap[oldPath]
      this.saveSettings()
    })
    this.addCommand({
      id: 'readwise-plugin-sync',
      name: 'trigger Readwise sync',
      icon: 'documents',
      callback: () => {
        if (this.settings.isSyncing) {
          console.log('skipping Readwise sync: already in progress');
          new Notice("Readwise sync already in progress");
        } else {
          this.settings.isSyncing = true;
          this.saveSettings();
          this.requestArchive();
        }
      }

    });
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!ctx.sourcePath.startsWith("Readwise")) {
        return
      }
      // @ts-ignore
      let matches = [...ctx.getSectionInfo(el).text.matchAll(/__(.+)__/g)].map((a) => a[1])
      const hypers = el.findAll("strong").filter(e => matches.contains(e.textContent))
      hypers.forEach(strongEl => {
        const replacement = el.createEl('span')
        replacement.innerHTML = strongEl.innerHTML
        replacement.addClass("rw-hyper-highlight")
        strongEl.replaceWith(replacement)
      })
    })
    this.addSettingTab(new ReadwiseSettingTab(this.app, this));
    this.configureSchedule();
    if (this.settings.triggerOnLoad) {
      this.requestArchive()
    }
  }

  onunload() {
    console.log('ReadwisePlugin: unloading');
    // should we do something more here?
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    return this.saveData(this.settings);
  }

  async getUserAuthToken(button: HTMLElement, attempt = 0) {
    let uuid = this.settings.obsidianToken || Math.random().toString(36).substring(2, 15)

    if (attempt === 0) {
      window.open(`${baseURL}/api_auth?token=${uuid}&service=obsidian`);
    }

    let response, data: ReadwiseAuthResponse
    try {
      response = await fetch(
        `${baseURL}/api/auth?token=${uuid}`
      )
    } catch (e) {
      console.log("ReadwisePlugin: fetch failed in getUserAuthToken: ", e)
    }
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("ReadwisePlugin: bad response in getUserAuthToken: ", response)
      // TODO: handle token error
      this.showInfoStatus(button.parentElement, "Authorization failed. Try again", "rw-error")
      return
    }
    if (!this.settings.obsidianToken) {
      this.settings.obsidianToken = uuid
      await this.saveSettings()
    }
    if (data.userAccessToken) {
      this.settings.token = data.userAccessToken;
    } else {
      if (attempt > 20) {
        console.log('ReadwisePlugin: reached attempt limit in getUserAuthToken')
        return
      }
      console.log(`ReadwisePlugin: didn't get token data, retrying (attempt ${attempt + 1})`)
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.getUserAuthToken(button, attempt + 1)
    }
    this.saveSettings()

    // change our button text
    button.setText("Reconnect");
    return true
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
    containerEl.createEl('h2', {text: 'Readwise Sync'});

    if (this.plugin.settings.token) {
      new Setting(containerEl)
        .setName("Sync data")
        .setClass('rw-setting-sync')
        .addButton((button) => {
          button.setButtonText('Run sync')
            .onClick(() => {
              if (this.plugin.settings.isSyncing) {
                // TODO: This is used to prevent multiple syncs at the same time. However, if a previous sync fails,
                //  it can stop new syncs from happening. Make sure to set isSyncing to false
                //  if there's ever errors/failures in previous sync attempts, so that
                //  we don't block syncing subsequent times.
                console.log('skipping sync init');
                new Notice("Readwise sync already in progress");
              } else {
                this.plugin.clearInfoStatus(containerEl)
                this.plugin.settings.isSyncing = true;
                this.plugin.saveData(this.plugin.settings);
                this.plugin.requestArchive(button);
                button.setButtonText("Syncing...");
              }

            })
        });
      let el = containerEl.createEl("div", {cls: "rw-info"})
      containerEl.find(".rw-setting-sync > .setting-item-control ").prepend(el)

      // let descriptionText = this.plugin.settings.token != "" ? "Token saved." : "No token set.";
      new Setting(containerEl)
        .setName("Configure Export")
        .setDesc("open your export settings in Readwise")
        .addButton((button) => {
          button.setButtonText("Go to Readwise config page").onClick(() => {
            window.open(`${baseURL}/export/obsidian/preferences`);
          })
        })

      new Setting(containerEl)
        .setName("Resync books on file deletion")
        .setDesc("when you delete a file inside the Readwise directory, the book will be downloaded again on the next sync")
        .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.refreshBooks)
            toggle.onChange((val) => {
              this.plugin.settings.refreshBooks = val;
              this.plugin.saveSettings()
            })
          }
        )
      new Setting(containerEl)
        .setName('Sync Frequency')
        .setDesc("how often to check for new highlights")
        .addDropdown(dropdown => {
          dropdown.addOption("0", "manual");
          dropdown.addOption("60", "1 hour");
          dropdown.addOption((12 * 60).toString(), "12 hours");
          dropdown.addOption((24 * 60).toString(), "daily");

          // select the currently-saved option
          dropdown.setValue(this.plugin.settings.frequency);

          dropdown.onChange((newValue) => {
            console.log('newValue set', newValue)

            // update the plugin settings
            this.plugin.settings.frequency = newValue;
            this.plugin.saveData(this.plugin.settings);

            // destroy & re-create the scheduled task
            this.plugin.configureSchedule();
          })
        });
      new Setting(containerEl)
        .setName("Trigger a sync on app load")
        .addToggle((toggle) => {
            toggle.setValue(this.plugin.settings.triggerOnLoad)
            toggle.onChange((val) => {
              this.plugin.settings.triggerOnLoad = val;
              this.plugin.saveSettings()
            })
          }
        )

      if (this.plugin.settings.lastSyncFailed) {
        this.plugin.showInfoStatus(containerEl.find(".rw-setting-sync .rw-info").parentElement, "Last sync failed", "rw-error")
      }
    }
    new Setting(containerEl)
      .setName("Connect to Readwise")
      .setClass("rw-setting-connect")
      .addButton((button) => {
        let text = this.plugin.settings.token ? "Reconnect" : "CONNECT";
        button.setButtonText(
          text
        ).onClick(async (evt) => {
          const success = await this.plugin.getUserAuthToken(evt.target as HTMLElement)
          if (success) {
            this.display()
          }
        })
      })
    let el = containerEl.createEl("div", {cls: "rw-info"})
    containerEl.find(".rw-setting-connect > .setting-item-control ").prepend(el)

  }
}
