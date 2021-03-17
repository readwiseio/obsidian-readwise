import { schedulingPolicy } from 'cluster';
import { timeStamp } from 'node:console';
import { App, Modal, Notice, Plugin, Vault, PluginSettingTab, Setting, DataAdapter, ButtonComponent } from 'obsidian';

require('electron');

interface sampleDataFormat extends JSON {
	content: string;
	fileName: string
}

interface MyPluginSettings {
	token: string;
	sampleDataURL: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	token: 'default',
	sampleDataURL: 'https://gist.github.com/jborichevskiy/c650c7cf4cc489a4925dddab485e5bd9/raw/341e666d97429e60521e3d2c9831a6d8053b1f23/data.json'
}


export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	fs: DataAdapter;
	vault: Vault;

	async fetchContent(url: string): Promise<sampleDataFormat> {
		const response = await fetch(url);
		return response.json();
	}

	async writeFile(data: sampleDataFormat): Promise<void> {
		let fileExists = await this.fs.exists(data.fileName);
		if (fileExists) {
			console.log('file already exists!');
		} else {
			console.log('does not exist');
			await this.fs.write(data.fileName, data.content);
		}
	}

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'init-sync',
			name: 'Sync Readwise Highlights',
			callback: () => {
				this.vault = this.app.vault;
				this.fs = this.vault.adapter;

				this.fetchContent(this.settings.sampleDataURL).then((data) => this.writeFile(data))
			}
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.registerCodeMirror((cm: CodeMirror.Editor) => {
			console.log('codemirror', cm);
		});

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	onunload() {
		console.log('unloading plugin');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		console.log('loaded settings', this.settings)
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
				button.setButtonText("Open Readwise.io")
					.onClick(() => {
						window.open("https://readwise.io/access_token");
					})
			})


		let descriptionText;
		if (this.plugin.settings.token) {
			descriptionText = "Token saved."
		} else {
			descriptionText = "No token set."
		}

		new Setting(containerEl)
			.setName('Access Token')
			.setDesc(descriptionText)
			.setClass('tokenSetting')
			.addText(text => text
				.setPlaceholder('Enter your access token here')
				.setValue(this.plugin.settings.token)
				.onChange(async (value) => {
					console.log('Secret: ' + value);
					this.plugin.settings.token = value;

					// TODO: cleaner way of doing this
					containerEl.querySelector('.tokenSetting').querySelector('.setting-item-description').innerText = "Token saved!"

					await this.plugin.saveSettings();
				}));
	}
}
