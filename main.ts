import {App, ButtonComponent, DataAdapter, Plugin, PluginSettingTab, setIcon, Setting, Vault} from 'obsidian';
import * as zip from "@zip.js/zip.js";


require('electron');

const path = require("path")


const baseURL = process.env.READWISE_SERVER_URL || "https://readwise.io"

interface ReadwiseAuthResponse extends JSON {
  userAccessToken: string;
}

interface ExportStatusFormat {
  latest_id: number,
  status: string
}

interface ReadwisePluginSettings {
  token: string;
  obsidianToken: string;
  isSyncing: boolean;
  frequency: string;
  lastSyncFailed: boolean;
  lastSavedStatusID: number;
  product: string;
  refreshBooks: boolean,
  booksToRefresh: Array<string>;
  booksIDsMap: { [key: string]: string; };
}

// define our initial settings
const DEFAULT_SETTINGS: ReadwisePluginSettings = {
  token: "",
  obsidianToken: "",
  frequency: "0", // manual by default
  isSyncing: false,
  lastSyncFailed: false,
  lastSavedStatusID: 0,
  product: "trial",
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
      this.showSyncStatus(buttonContext.buttonEl.parentElement, msg, "rw-error")
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
      this.showSyncStatus(buttonContext.buttonEl.parentNode.parentElement, msg, "rw-success")
      buttonContext.buttonEl.setText("Run sync");
    }
  }

  async getProfileInfo() {
    let url = `${baseURL}/api/profile/`
    let response
    try {
      response = await fetch(
        url,
        {
          headers: this.getAuthHeaders()
        }
      )
    } catch (e) {
      // network failed
      console.log("ReadwisePlugin: Fetch Request failed: ", e)
    }

    if (response && response.ok) {
      return await response.json();
    } else {
      console.log("ReadwisePlugin: Response failed: ", response)
      return {}
    }
  }

  async requestArchive(buttonContext?: ButtonComponent, statusId?: number) {

    const parentDeleted = !await this.app.vault.adapter.exists("Readwise")

    let url = `${baseURL}/api/obsidian/init?parentPageDeleted=${parentDeleted}`
    if (statusId) {
      url += `&statusID=${statusId}`
    }
    let response, data: ExportStatusFormat
    response = await fetch(
      url,
      {
        headers: this.getAuthHeaders()
      }
    ).catch((e) => {
      console.log("Request failed: ", e)
    });
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("Response failed: ", response)
      this.handleSyncError(buttonContext, response ? response.statusText : "Can't connect to server")
      return
    }
    const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY']
    const SUCCESS_STATUSES = ['SUCCESS']
    if (WAITING_STATUSES.includes(data.status)) {
      // re-try in 1 second
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.requestArchive(buttonContext, data.latest_id);

    } else if (SUCCESS_STATUSES.includes(data.status)) {

      this.downloadArchive(data.latest_id, buttonContext);

    } else {
      this.handleSyncError(buttonContext, "Sync failed")
    }
  }

  showSyncStatus(container: HTMLElement, msg: string, className = "") {
    let info = container.find('.syncInfo')
    info.setText(msg)
    info.addClass(className)
  }

  clearSyncStatus(container: HTMLElement) {
    let info = container.find('.syncInfo')
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
      return
    }

    let response, blob
    response = await fetch(
      artifactURL, {headers: this.getAuthHeaders()}
    ).catch((e) => {
      console.log("Request failed: ", e)
    });
    if (response && response.ok) {
      blob = await response.blob();
    } else {
      console.log("Response failed: ", response)
      this.handleSyncError(buttonContext, response ? response.statusText : "Can't connect to server")
      return
    }

    this.fs = this.app.vault.adapter;

    const blobReader = new zip.BlobReader(blob);
    const zipReader = new zip.ZipReader(blobReader);
    const entries = await zipReader.getEntries();

    if (entries.length) {
      for (const entry of entries) {
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
          this.settings.booksIDsMap[originalName] = split.last().match(/\d+/g)[0];
        }

        if (await this.fs.exists(originalName)) {
          // if the file already exists we need to append content to existing one
          const existingContent = await this.fs.read(originalName)
          contentToSave = existingContent + contents
        }
        await this.fs.write(originalName, contentToSave)
        await this.saveSettings()
      }
    }
    // close the ZipReader
    await zipReader.close();
    this.handleSyncSuccess(buttonContext, "Synced!", exportID)
  }


  async configureSchedule() {
    const minutes = parseInt(this.settings.frequency)

    let milliseconds = minutes * 60 * 1000; // minutes * seconds * milliseconds
    console.log('setting interval to ', milliseconds, 'milliseconds');

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
    response = await fetch(
      `${baseURL}/api/refresh_book_export`,
      {
        headers: this.getAuthHeaders(),
        method: "POST",
        body: formData
      }
    ).catch((e) => {
      console.log("Request failed: ", e)
    });
    if (response && response.ok) {
      return
    } else {
      console.log("Response failed: ", response)
      // this.settings.booksToRefresh.push(bookId)
      // this.saveSettings()
      return
    }
  }

  async onload() {
    await this.loadSettings();
    if (this.settings.token) {
      const profileInfo = await this.getProfileInfo()
      if (profileInfo) {
        this.settings.product = profileInfo.product
        await this.saveSettings()
      }
    }
    this.addSettingTab(new ReadwiseSettingTab(this.app, this));
    this.configureSchedule();
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
  }

  onunload() {
    console.log('unloading plugin');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    return this.saveData(this.settings);
  }

  async getUserAuthToken(button: HTMLElement, attempt = 0) {
    let uuid = this.settings.obsidianToken || Math.random().toString(36).substring(2, 15)

    // TODO: this is the existing endpoint that ibooks uses, is userfacing
    if (attempt === 0) {
      window.open(`${baseURL}/api_auth?token=${uuid}&service=obsidian`);
    }

    let response, data: ReadwiseAuthResponse
    response = await fetch(
      `${baseURL}/api/auth?token=${uuid}`
    ).catch((e) => {
      console.log("Request failed: ", e)
    });
    if (response && response.ok) {
      data = await response.json();
    } else {
      console.log("Response failed: ", response)
      // TODO: handle token error
      // this.handleSyncError(buttonContext, response ? response.statusText : "Can't connect to server")
      return
    }
    console.log("Got Token! Data:", data)
    if (!this.settings.obsidianToken) {
      this.settings.obsidianToken = uuid
      await this.saveSettings()
    }
    if (data.userAccessToken) {
      this.settings.token = data.userAccessToken;
    } else {
      if (attempt > 20) {
        console.log(`TOO MANY ATTEMPTS`)
        return
      }
      console.log(`didn't get token data, retrying (attempt no ${attempt + 1})`)
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.getUserAuthToken(button, attempt + 1)
    }
    this.saveSettings()

    // update the value of the token element for the user
    // const input = button.nextElementSibling as HTMLInputElement
    // input.value = data.userAccessToken;

    // change our button text
    button.setText("Reconnect");
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
        .setClass('syncSetting')
        .addButton((button) => {
          button.setButtonText('Run sync')
            .onClick(() => {
              if (this.plugin.settings.isSyncing) {
                // TODO: This is used to prevent multiple syncs at the same time. However, if a previous sync fails,
                //  it can stop new syncs from happening. Make sure to set isSyncing to false
                //  if there's ever errors/failures in previous sync attempts, so that
                //  we don't block syncing subsequent times.
                console.log('skipping sync init');
              } else {
                this.plugin.clearSyncStatus(containerEl)
                this.plugin.settings.isSyncing = true;
                this.plugin.saveData(this.plugin.settings);
                this.plugin.requestArchive(button);
                button.setButtonText("Syncing...");
              }

            })
        });
      let el = containerEl.createEl("div", {cls: "syncInfo"})
      containerEl.find(".syncSetting > .setting-item-control ").prepend(el)

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
          if (this.plugin.settings.product === "full") {
            // dropdown.addOption("30", "30 mins");
            dropdown.addOption("60", "1 hour");
          }
          dropdown.addOption((12 * 60).toString(), "12 hours");
          dropdown.addOption((24 * 60).toString(), "daily");
          dropdown.addOption("0", "manual");

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

      if (this.plugin.settings.lastSyncFailed) {
        // debugger;
        this.plugin.showSyncStatus(containerEl.find(".syncInfo").parentElement, "Last sync failed", "rw-error")
      }
    }
    new Setting(containerEl)
      .setName("Connect to Readwise")
      .addButton((button) => {
        let text = this.plugin.settings.token ? "Reconnect" : "CONNECT";
        button.setButtonText(
          text
        ).onClick(async (evt) => {
          await this.plugin.getUserAuthToken(evt.target as HTMLElement)
          this.display()
        })
      })
    // .addText(text => text
    //   .setPlaceholder('Enter your access token here')
    //   .setValue(this.plugin.settings.token)
    //   .onChange(async (value) => {
    //     console.log('Secret: ' + value);
    //     this.plugin.settings.token = value;
    //
    //     // TODO: cleaner way of doing this
    //     // containerEl.querySelector('.tokenSetting').querySelector('.setting-item-description').setVal = "Token saved!"
    //     await this.plugin.saveSettings();
    //   }))
    // .addExtraButton(button => {
    //   button.setIcon("dot-network")
    // });


  }
}
