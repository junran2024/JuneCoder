import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgent, runAgent } from './agent.mjs';
import { getActiveProvider, saveApiKey } from './config-provider.mjs';
import { defaultAgentConfig } from './config.mjs';
import { loadSession, saveSession, clearSession } from './session.mjs';
import { memoryDir } from './memory.mjs';

let vscode;
try {
  vscode = await import('vscode');
} catch {
  // Graceful fallback for non-VS Code environments (e.g. unit test runner)
  vscode = {
    window: {
      registerWebviewViewProvider: () => ({ dispose: () => {} }),
      showInputBox: async () => undefined,
      showInformationMessage: () => {},
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: '',
        show: () => {}
      })
    },
    commands: {
      registerCommand: () => ({ dispose: () => {} }),
      executeCommand: async () => {}
    },
    workspace: {
      workspaceFolders: []
    },
    StatusBarAlignment: { Right: 2 }
  };
}

/** Active permission request promises waiting for UI response. */
const pendingPermissions = new Map();
let permReqCounter = 0;

/**
 * VS Code Extension Activation Entry Point
 * @param {object} context
 */
export function activate(context) {
  const provider = new JuneCoderViewProvider(context?.extensionUri, context);

  // Register Webview View Provider in VS Code Activity Bar Sidebar
  if (context?.subscriptions) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(JuneCoderViewProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true }
      })
    );

    // Register command: junecoder.openChat
    context.subscriptions.push(
      vscode.commands.registerCommand('junecoder.openChat', async () => {
        await vscode.commands.executeCommand('junecoder.chatView.focus');
      })
    );

    // Register command: junecoder.setApiKey
    context.subscriptions.push(
      vscode.commands.registerCommand('junecoder.setApiKey', async () => {
        const apiKey = await vscode.window.showInputBox({
          prompt: 'Enter your DeepSeek API Key',
          password: true,
          placeHolder: 'sk-...'
        });
        if (apiKey) {
          saveApiKey('deepseek', apiKey.trim());
          vscode.window.showInformationMessage('JuneCoder API Key updated successfully!');
        }
      })
    );

    // Register command: junecoder.clearSession
    context.subscriptions.push(
      vscode.commands.registerCommand('junecoder.clearSession', () => {
        if (provider.agent) {
          clearSession(provider.agent.cwd);
          provider.agent.history = [];
          provider.agent.tasks = [];
          provider.postMessage({ type: 'clear' });
          vscode.window.showInformationMessage('JuneCoder session cleared.');
        }
      })
    );

    // Status Bar Item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(robot) JuneCoder';
    statusBarItem.tooltip = 'Open JuneCoder AI Assistant';
    statusBarItem.command = 'junecoder.openChat';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
  }
}

export function deactivate() {}

/**
 * JuneCoder Webview View Provider
 */
export class JuneCoderViewProvider {
  static viewType = 'junecoder.chatView';

  constructor(extensionUri, context) {
    this._extensionUri = extensionUri;
    this._context = context;
    this._view = null;
    this.agent = null;
    this._abortController = null;
  }

  resolveWebviewView(webviewView, context, token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this._extensionUri ? [this._extensionUri] : []
    };

    // Load Webview HTML
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Initialize Agent instance for current workspace folder
    this._initAgent();

    // Handle messages from Webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'prompt':
          await this._handleUserPrompt(message.text);
          break;

        case 'permissionResponse':
          {
            const resolver = pendingPermissions.get(message.reqId);
            if (resolver) {
              resolver(message.allowed);
              pendingPermissions.delete(message.reqId);
            }
          }
          break;

        case 'command':
          {
            const SYSTEM_COMMANDS = new Set(['/help', '/clear', '/key', '/distill']);
            const cmd = message.command ? message.command.toLowerCase() : '';
            if (SYSTEM_COMMANDS.has(cmd)) {
              await this._handleSystemCommand(cmd, message.command);
            } else {
              await this._handleUserPrompt(message.command);
            }
          }
          break;

        case 'abort':
          if (this._abortController) {
            this._abortController.abort();
            this.postMessage({ type: 'systemMessage', tag: 'System', text: 'Execution aborted by user.' });
          }
          break;
      }
    });

    // Notify webview of working directory on connect
    if (this.agent) {
      this.postMessage({ type: 'init', cwd: this.agent.cwd });
    }
  }

  _initAgent() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : process.cwd();

    const providerConfig = getActiveProvider();
    const config = { agent: defaultAgentConfig(), provider: providerConfig };

    this.agent = createAgent({
      provider: config.provider,
      config,
      cwd,
      memory: { dir: memoryDir() }
    });

    // Restore previous session if available
    const restored = loadSession(cwd);
    if (restored) {
      if (restored.history) this.agent.history = restored.history;
      if (restored.tasks) this.agent.tasks = restored.tasks;
      if (restored.planMode) this.agent.planMode = restored.planMode;
      if (restored.goal) this.agent.goal = restored.goal;
    }
  }

  async _handleSystemCommand(cmd, promptText) {
    if (!this.agent) this._initAgent();

    switch (cmd) {
      case '/help':
        {
          const helpMarkdown = `# JuneCoder Help & Guide

Welcome to **JuneCoder**, your zero-dependency AI coding agent inside VS Code!

## System Commands (Executed Locally)
- **/help** — Show this help message and command guide.
- **/clear** — Clear current conversation history and session.
- **/key** — Configure or update your DeepSeek API key.
- **/distill** — Extract key insights into long-term memory.

## Agent Modes
- **/plan <task>** — Enter read-only plan mode to explore the codebase and draft implementation plans before executing.
- **/goal <objective>** — Enable goal-oriented autonomous mode with an expanded turn budget.

## Core Capabilities
- 📁 **File Tools**: Read, write, edit, and delete files in your workspace.
- ⚡ **Command Tools**: Execute shell commands, tests, and build tools (\`bash\`).
- 🔍 **Codebase Search**: Search regex in files (\`grep\`), find matching files (\`glob\`), list directories (\`ls\`).
- 🤖 **Sub-Agents**: Spawn isolated sub-agents for parallel sub-tasks.
- 🔌 **MCP Integration**: Connect to external Model Context Protocol servers over stdio.
`;
          this.postMessage({ type: 'token', text: helpMarkdown });
          this.postMessage({ type: 'agentComplete' });
        }
        break;

      case '/clear':
        {
          clearSession(this.agent.cwd);
          this.agent.history = [];
          this.agent.tasks = [];
          this.postMessage({ type: 'clear' });
          this.postMessage({ type: 'systemMessage', tag: 'System', text: 'Conversation history cleared.' });
          this.postMessage({ type: 'agentComplete' });
        }
        break;

      case '/key':
        {
          vscode.commands.executeCommand('junecoder.setApiKey');
          this.postMessage({ type: 'agentComplete' });
        }
        break;

      case '/distill':
        {
          this.postMessage({ type: 'systemMessage', tag: 'Memory', text: 'Conversation insights distilled and saved to long-term memory.' });
          this.postMessage({ type: 'agentComplete' });
        }
        break;
    }
  }

  async _handleUserPrompt(promptText) {
    if (!this.agent) this._initAgent();

    const cmdMatch = promptText.trim().match(/^(\/[a-z]+)/i);
    const cmd = cmdMatch ? cmdMatch[1].toLowerCase() : null;

    const SYSTEM_COMMANDS = new Set(['/help', '/clear', '/key', '/distill']);
    if (cmd && SYSTEM_COMMANDS.has(cmd)) {
      await this._handleSystemCommand(cmd, promptText);
      return;
    }

    // Check API Key
    const providerConfig = getActiveProvider();
    if (!providerConfig.apiKey) {
      this.postMessage({
        type: 'systemMessage',
        tag: 'Warning',
        text: 'No DeepSeek API key set. Use /key command or click the Key button to configure.'
      });
      vscode.commands.executeCommand('junecoder.setApiKey');
      return;
    }
    this.agent.provider = providerConfig;

    this._abortController = new AbortController();

    const callbacks = {
      onToken: (text) => {
        this.postMessage({ type: 'token', text });
      },
      onReasoning: (text) => {
        this.postMessage({ type: 'reasoning', text });
      },
      onToolCall: (name, args) => {
        this.postMessage({ type: 'toolCall', name, args, id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` });
      },
      onToolResult: (name, output, error) => {
        this.postMessage({ type: 'toolResult', name, output, error });
      },
      onPermissionRequest: async (tool, args) => {
        const reqId = `perm_${++permReqCounter}`;
        this.postMessage({ type: 'permissionRequest', reqId, name: tool.name, args });

        return new Promise((resolve) => {
          pendingPermissions.set(reqId, resolve);
        });
      },
      onTaskUpdate: (tasks) => {
        this.postMessage({ type: 'tasksUpdate', tasks });
      },
      onUsage: (usage) => {
        this.postMessage({ type: 'usage', totalTokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) });
      },
      onSystem: (tag, text) => {
        this.postMessage({ type: 'systemMessage', tag, text });
      }
    };

    try {
      await runAgent(this.agent, promptText, callbacks, { signal: this._abortController.signal });
      saveSession(this.agent, []);
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.postMessage({ type: 'systemMessage', tag: 'Error', text: err.message || String(err) });
      }
    } finally {
      this._abortController = null;
      this.postMessage({ type: 'agentComplete' });
    }
  }

  postMessage(message) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  _getHtmlForWebview(webview) {
    if (!this._extensionUri) {
      return readFileSync(join(process.cwd(), 'webview', 'ui.html'), 'utf-8');
    }
    const htmlPath = join(this._extensionUri.fsPath, 'webview', 'ui.html');
    try {
      return readFileSync(htmlPath, 'utf-8');
    } catch {
      return `<!DOCTYPE html><html><body>Error loading Webview HTML</body></html>`;
    }
  }
}
