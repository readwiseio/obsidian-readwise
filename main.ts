import { App, Modal, Notice, Plugin, Vault, PluginSettingTab, Setting, DataAdapter, ButtonComponent, DropdownComponent } from 'obsidian';
import * as zip from "@zip.js/zip.js";


require('electron');
var fs = require("fs");

// TODO: pull from env?
const baseURL = "https://local.readwise.io:8000"

interface readwiseAuthResponse extends JSON {
	userAccessToken: string;
}

interface exportStatusFormat {
	latest_id: Number,
	status: string
}

interface MyPluginSettings {
	token: string;
	// latestStatusID?: number;
	isSyncing: boolean;
	frequency: string;
}

// define our initial settings
const DEFAULT_SETTINGS: MyPluginSettings = {
	token: "",
	frequency: "60",
	// latestStatusID: null,
	isSyncing: false
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	fs: DataAdapter;
	vault: Vault;

	async fetchToken(url: string): Promise<readwiseAuthResponse> {
		const response = await fetch(url);
		return response.json();
	}

	async requestArchive(buttonContext?: ButtonComponent) {
		const response = await fetch(
			`${baseURL}/api/obsidian/init`,
			{
				headers: {
					'X-Access-Token': this.settings.token
				}
			}
		);

		let data = await response.json();

		if (data.status == "waiting") {
			// re-try in 1 second
			await new Promise(resolve => setTimeout(resolve, 1000));
			await this.requestArchive(buttonContext);
		} else if (response.status != 200) {
			console.log('something went wrong, response:', response)
			// re-try in 1 second
			await new Promise(resolve => setTimeout(resolve, 1000));
			await this.requestArchive(buttonContext);
		} else {
			this.downloadArchive(data.latest_id, buttonContext);
		}
	}

	async downloadArchive(exportID: Number, buttonContext: ButtonComponent): Promise<void> {
		let artifactURL = `${baseURL}/api/download_artifact/${exportID}`
		let blob = await fetch(artifactURL, {
			headers: {
				'X-Access-Token': this.settings.token
			}
		}).then(r => r.blob());

		this.fs = this.app.vault.adapter;

		var blobReader = new zip.BlobReader(blob);
		var zipReader = new zip.ZipReader(blobReader);
		const entries = await zipReader.getEntries();

		if (entries.length) {
			entries.forEach((entry) => {
				let path = entry.filename.split("/")[0];

				// ensure the directory exists
				this.fs.exists(path).then(exists => {
					if (!exists) {
						this.fs.mkdir(path);
					}
				})

				// write the actual file, overwrite ok
				entry.getData(new zip.TextWriter()).then(contents => {
					this.fs.write(entry.filename, contents)
				});
			})
		}

		// close the ZipReader
		await zipReader.close();

		// set our state to isSyncing:false
		this.settings.isSyncing = false;
		this.saveData(this.settings);

		// if we have a button context, update the text on it
		// this is the case if we fired on a "Run sync" click (the button)
		if (buttonContext != null) {
			buttonContext.buttonEl.setText("Run sync");
		}
	}

	async requestExportDetails(): Promise<exportStatusFormat> {
		const response = await fetch(`${baseURL}/api/obsidian_latest/`, {
			headers: {
				'X-Access-Token': this.settings.token
			}
		});

		return response.json()
	}

	async configureSchedule() {
		let minutes;
		if (this.settings.frequency == "daily") {
			minutes = 60 * 24 // 1 day in minutes
		} else {
			minutes = parseInt(this.settings.frequency); // dynamic val in minutes
		}

		let milliseconds = minutes * 60 * 1000; // minutes * seconds * milliseconds
		console.log('setting interval to ', milliseconds, 'milliseconds');

		window.clearInterval();
		this.registerInterval(
			window.setInterval(() => this.requestArchive(), 
			milliseconds)
		);
	}

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.configureSchedule();
	}

	onunload() {
		console.log('unloading plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Readwise Sync' });

		new Setting(containerEl)
			.setName("Connect to Readwise")
			.setDesc("Find your access token.")
			.addButton((button) => {
				let text = this.plugin.settings.token == "" ? "Open Readwise.io" : "Reconnect";
				button.setButtonText(text)
					.onClick(() => {
						// TODO: generate a real UUID
						let uuid = 'helloworld123123'

						// TODO: this is the existing endpoint that ibooks uses, is userfacing
						window.open(`${baseURL}/api_auth?token=${uuid}&service=obsidian`);

						// TODO: this endpoint is used by the plugin, potentially should rename it to reduce confusion
						this.plugin.fetchToken(`${baseURL}/api/auth?token=${uuid}`).then((
							data: readwiseAuthResponse) => {
							// update token in settings
							this.plugin.settings.token = data.userAccessToken;
							this.plugin.saveData(this.plugin.settings);

							// update the value of the token element for the user
							let target = containerEl.querySelector('.tokenSetting').querySelector('.setting-item-control input') as HTMLInputElement;
							target.value = data.userAccessToken;

							// change our button text
							button.setButtonText("Reconnect");
						})
					})
			})
			.addButton((button) => {
				button.setButtonText('Run sync')
					.onClick(() => {
						// TODO: disable this button until there is an access token
						if (false) {
						 	// TODO: This is used to prevent multiple syncs at the same time. However, if a previous sync fails, it can stop new syncs from happening. Make sure to set isSyncing to false if there's ever errors/failures in previous sync attempts, so that we don't block syncing subsequent times.
							console.log('skipping sync init');
						} else {
							this.plugin.requestArchive(button);

							this.plugin.settings.isSyncing = true;
							this.plugin.saveData(this.plugin.settings);

							button.setButtonText("Syncing...");
						}

					})
			})

		// let descriptionText = this.plugin.settings.token != "" ? "Token saved." : "No token set.";

		new Setting(containerEl)
			.setName('Access Token')
			// .setDesc(descriptionText)
			.setClass('tokenSetting')
			.addText(text => text
				.setPlaceholder('Enter your access token here')
				.setValue(this.plugin.settings.token)
				.onChange(async (value) => {
					console.log('Secret: ' + value);
					this.plugin.settings.token = value;

					// TODO: cleaner way of doing this
					// containerEl.querySelector('.tokenSetting').querySelector('.setting-item-description').setVal = "Token saved!"

					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Configure Export")
			.addButton((button) => {
				button.setButtonText("open browser").onClick(() => {
					window.open(`${baseURL}/export/obsidian/preferences`);
				})
			})

		new Setting(containerEl)
			.setName('Sync Frequency')
			.setDesc("how often to check for new highlights")
			.addDropdown(dropdown => {
				// create the options
				[1, 5, 10, 30, 60].forEach(
					(value) => {
						let minsText = value == 1 ? "min" : "mins"
						dropdown.addOption(value.toString(), `${value} ${minsText}`)
					}
				)

				dropdown.addOption("daily", "daily");

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

	}
}
