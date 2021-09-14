// Inspired by
// https://github.com/renehernandez/obsidian-readwise/blob/eee5676524962ebfa7eaf1084e018dafe3c2f394/src/status.ts

export class StatusBar {
  private messages: StatusBarMessage[] = [];
  private currentMessage: StatusBarMessage;
  private lastMessageTimestamp: number;
  private statusBarEl: HTMLElement;

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
  }

  displayMessage(message: string, timeout: number, forcing: boolean = false) {
    if (this.messages[0] && this.messages[0].message === message) {
      // don't show the same message twice
      return;
    }
    this.messages.push({
      message: `readwise: ${message.slice(0, 100)}`,
      timeout: timeout * 1000,
    });
    if (forcing) {
      this.currentMessage = null;
      this.lastMessageTimestamp = null;
      this.statusBarEl.setText("");
    }
    this.display();
  }

  display() {
    if (this.currentMessage) {
      let messageAge = Date.now() - this.lastMessageTimestamp;
      if (messageAge >= this.currentMessage.timeout) {
        this.currentMessage = null;
        this.lastMessageTimestamp = null;
      }
    } else if (this.messages.length) {
      this.currentMessage = this.messages.shift();
      this.statusBarEl.setText(this.currentMessage.message);
      this.lastMessageTimestamp = Date.now();
      return;
    } else {
      this.statusBarEl.setText("");
    }
  }
}

export interface StatusBarMessage {
  message: string;
  timeout: number;
}
