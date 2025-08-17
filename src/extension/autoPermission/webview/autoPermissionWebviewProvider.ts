/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAutoPermissionService, PermissionProfile, PermissionRule } from '../../../platform/autoPermission/common/autoPermissionService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

interface WebviewMessage {
	type: string;
	data?: any;
}

export class AutoPermissionWebviewProvider extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewType = 'github.copilot.autoPermission';

	private _view?: vscode.WebviewView;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		@IAutoPermissionService private readonly _autoPermissionService: IAutoPermissionService,
		@ILogService private readonly _logService: ILogService
	) {
		super();

		// Listen for permission changes to update the UI
		this._register(this._autoPermissionService.onPermissionChange(() => {
			this._updateView();
		}));

		this._register(this._autoPermissionService.onPermissionDecision((event) => {
			this._sendMessage({
				type: 'permissionDecision',
				data: {
					context: event.context,
					result: event.result,
					timestamp: event.timestamp
				}
			});
		}));
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: []
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(
			async (message: WebviewMessage) => {
				try {
					await this._handleMessage(message);
				} catch (error) {
					this._logService.error('AutoPermissionWebviewProvider: Error handling message', error);
					this._sendMessage({
						type: 'error',
						data: { message: `Error: ${error}` }
					});
				}
			},
			undefined,
			this._disposables
		);

		// Send initial data
		this._updateView();
	}

	private async _handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'getInitialData':
				this._updateView();
				break;

			case 'activateProfile':
				if (message.data?.profileId) {
					await this._autoPermissionService.setActiveProfile(message.data.profileId);
					vscode.window.showInformationMessage(`Profile activated: ${message.data.profileName || 'Unknown'}`);
				}
				break;

			case 'deleteProfile':
				if (message.data?.profileId) {
					const confirm = await vscode.window.showWarningMessage(
						`Are you sure you want to delete profile "${message.data.profileName}"?`,
						'Delete', 'Cancel'
					);
					if (confirm === 'Delete') {
						await this._autoPermissionService.deleteProfile(message.data.profileId);
						vscode.window.showInformationMessage(`Profile deleted: ${message.data.profileName}`);
					}
				}
				break;

			case 'toggleRule':
				if (message.data?.profileId && message.data?.ruleId) {
					const profile = this._autoPermissionService.getProfile(message.data.profileId);
					const rule = profile?.rules.find(r => r.id === message.data.ruleId);
					if (rule) {
						await this._autoPermissionService.updateRule(
							message.data.profileId,
							message.data.ruleId,
							{ enabled: !rule.enabled }
						);
					}
				}
				break;

			case 'deleteRule':
				if (message.data?.profileId && message.data?.ruleId) {
					const confirm = await vscode.window.showWarningMessage(
						`Are you sure you want to delete rule "${message.data.ruleName}"?`,
						'Delete', 'Cancel'
					);
					if (confirm === 'Delete') {
						await this._autoPermissionService.deleteRule(
							message.data.profileId,
							message.data.ruleId
						);
						vscode.window.showInformationMessage(`Rule deleted: ${message.data.ruleName}`);
					}
				}
				break;

			case 'createProfile':
				await vscode.commands.executeCommand('github.copilot.autoPermission.createProfile');
				break;

			case 'addRule':
				if (message.data?.profileId) {
					// For now, use the command - in a full implementation, we'd handle this in the webview
					await vscode.commands.executeCommand('github.copilot.autoPermission.addRule');
				}
				break;

			case 'viewAuditLog':
				await vscode.commands.executeCommand('github.copilot.autoPermission.viewAuditLog');
				break;

			case 'viewStatistics':
				await vscode.commands.executeCommand('github.copilot.autoPermission.viewStatistics');
				break;

			case 'updateConfiguration':
				if (message.data) {
					await this._autoPermissionService.updateConfiguration(message.data);
					vscode.window.showInformationMessage('Configuration updated');
				}
				break;

			default:
				this._logService.warn(`AutoPermissionWebviewProvider: Unknown message type: ${message.type}`);
		}
	}

	private _updateView(): void {
		if (!this._view) return;

		const profiles = this._autoPermissionService.getProfiles();
		const activeProfile = this._autoPermissionService.getActiveProfile();
		const config = this._autoPermissionService.getConfiguration();
		const statistics = this._autoPermissionService.getStatistics();

		this._sendMessage({
			type: 'updateData',
			data: {
				profiles,
				activeProfile,
				config,
				statistics
			}
		});
	}

	private _sendMessage(message: WebviewMessage): void {
		if (this._view) {
			this._view.webview.postMessage(message);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Auto-Permission Manager</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            font-weight: var(--vscode-font-weight);
            color: var(--vscode-foreground);
            background-color: var(--vscode-panel-background);
            margin: 0;
            padding: 16px;
        }

        .section {
            margin-bottom: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }

        .section-header {
            background-color: var(--vscode-sideBarSectionHeader-background);
            color: var(--vscode-sideBarSectionHeader-foreground);
            padding: 8px 12px;
            font-weight: bold;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .section-content {
            padding: 12px;
        }

        .profile-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .profile-item:last-child {
            border-bottom: none;
        }

        .profile-info {
            flex: 1;
        }

        .profile-name {
            font-weight: bold;
            margin-bottom: 2px;
        }

        .profile-description {
            font-size: 0.9em;
            opacity: 0.8;
        }

        .profile-status {
            font-size: 0.8em;
            padding: 2px 6px;
            border-radius: 3px;
            margin-left: 8px;
        }

        .profile-status.active {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        .profile-status.builtin {
            background-color: var(--vscode-textBlockQuote-background);
            color: var(--vscode-textBlockQuote-foreground);
        }

        .profile-actions {
            display: flex;
            gap: 4px;
        }

        .btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 8px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 0.8em;
        }

        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .btn.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .btn.danger {
            background-color: var(--vscode-errorForeground);
            color: var(--vscode-editor-background);
        }

        .rule-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .rule-item:last-child {
            border-bottom: none;
        }

        .rule-info {
            flex: 1;
        }

        .rule-name {
            font-weight: bold;
            margin-bottom: 2px;
        }

        .rule-details {
            font-size: 0.8em;
            opacity: 0.8;
        }

        .rule-status {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .toggle {
            position: relative;
            display: inline-block;
            width: 34px;
            height: 20px;
        }

        .toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 20px;
            transition: 0.2s;
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 2px;
            bottom: 2px;
            background-color: var(--vscode-input-foreground);
            border-radius: 50%;
            transition: 0.2s;
        }

        input:checked + .slider {
            background-color: var(--vscode-focusBorder);
        }

        input:checked + .slider:before {
            transform: translateX(14px);
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 12px;
        }

        .stat-item {
            text-align: center;
            padding: 8px;
            background-color: var(--vscode-editorWidget-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-widget-border);
        }

        .stat-value {
            font-size: 1.5em;
            font-weight: bold;
            margin-bottom: 4px;
        }

        .stat-label {
            font-size: 0.8em;
            opacity: 0.8;
        }

        .config-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .config-item:last-child {
            border-bottom: none;
        }

        .config-label {
            font-weight: bold;
        }

        .config-value {
            font-family: var(--vscode-editor-font-family);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            padding: 4px 8px;
            border-radius: 2px;
            color: var(--vscode-input-foreground);
        }

        .empty-state {
            text-align: center;
            padding: 20px;
            opacity: 0.6;
        }

        .loading {
            text-align: center;
            padding: 20px;
            opacity: 0.8;
        }

        .collapsible {
            cursor: pointer;
            user-select: none;
        }

        .collapsible:before {
            content: "▼ ";
            font-size: 0.8em;
            margin-right: 4px;
        }

        .collapsible.collapsed:before {
            content: "▶ ";
        }

        .collapsible-content {
            margin-top: 8px;
        }

        .collapsible.collapsed + .collapsible-content {
            display: none;
        }
    </style>
</head>
<body>
    <div class="section">
        <div class="section-header">
            <span>Configuration</span>
            <button class="btn secondary" onclick="openSettings()">Open Settings</button>
        </div>
        <div class="section-content">
            <div id="config-container" class="loading">Loading configuration...</div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">
            <span>Permission Profiles</span>
            <button class="btn" onclick="createProfile()">+ Create Profile</button>
        </div>
        <div class="section-content">
            <div id="profiles-container" class="loading">Loading profiles...</div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">
            <span>Active Profile Rules</span>
            <button class="btn secondary" onclick="addRule()">+ Add Rule</button>
        </div>
        <div class="section-content">
            <div id="rules-container" class="loading">Loading rules...</div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">
            <span>Statistics</span>
            <div>
                <button class="btn secondary" onclick="viewAuditLog()">Audit Log</button>
                <button class="btn secondary" onclick="viewStatistics()">Details</button>
            </div>
        </div>
        <div class="section-content">
            <div id="stats-container" class="loading">Loading statistics...</div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentData = null;

        // Send initial data request
        vscode.postMessage({ type: 'getInitialData' });

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'updateData':
                    currentData = message.data;
                    updateUI();
                    break;
                case 'error':
                    showError(message.data.message);
                    break;
                case 'permissionDecision':
                    showRecentDecision(message.data);
                    break;
            }
        });

        function updateUI() {
            if (!currentData) return;

            updateConfiguration();
            updateProfiles();
            updateRules();
            updateStatistics();
        }

        function updateConfiguration() {
            const container = document.getElementById('config-container');
            const config = currentData.config;

            container.innerHTML = \`
                <div class="config-item">
                    <span class="config-label">Service Enabled</span>
                    <label class="toggle">
                        <input type="checkbox" \${config.enabled ? 'checked' : ''} onchange="toggleService(this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="config-item">
                    <span class="config-label">Audit Logging</span>
                    <label class="toggle">
                        <input type="checkbox" \${config.auditEnabled ? 'checked' : ''} onchange="toggleAudit(this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="config-item">
                    <span class="config-label">Cache Enabled</span>
                    <label class="toggle">
                        <input type="checkbox" \${config.cacheEnabled ? 'checked' : ''} onchange="toggleCache(this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="config-item">
                    <span class="config-label">Max Audit Entries</span>
                    <input type="number" class="config-value" value="\${config.maxAuditEntries}" onchange="updateMaxAuditEntries(this.value)">
                </div>
            \`;
        }

        function updateProfiles() {
            const container = document.getElementById('profiles-container');
            const profiles = currentData.profiles || [];
            const activeProfile = currentData.activeProfile;

            if (profiles.length === 0) {
                container.innerHTML = '<div class="empty-state">No profiles available</div>';
                return;
            }

            container.innerHTML = profiles.map(profile => \`
                <div class="profile-item">
                    <div class="profile-info">
                        <div class="profile-name">
                            \${profile.name}
                            \${profile.isActive ? '<span class="profile-status active">Active</span>' : ''}
                            \${profile.isBuiltIn ? '<span class="profile-status builtin">Built-in</span>' : ''}
                        </div>
                        <div class="profile-description">\${profile.description}</div>
                        <div class="rule-details">
                            \${profile.rules.length} rules | Security: \${profile.securityLevel} | Default: \${profile.defaultDecision}
                        </div>
                    </div>
                    <div class="profile-actions">
                        \${!profile.isActive ? \`<button class="btn" onclick="activateProfile('\${profile.id}', '\${profile.name}')">Activate</button>\` : ''}
                        \${!profile.isBuiltIn ? \`<button class="btn danger" onclick="deleteProfile('\${profile.id}', '\${profile.name}')">Delete</button>\` : ''}
                    </div>
                </div>
            \`).join('');
        }

        function updateRules() {
            const container = document.getElementById('rules-container');
            const activeProfile = currentData.activeProfile;

            if (!activeProfile) {
                container.innerHTML = '<div class="empty-state">No active profile</div>';
                return;
            }

            const rules = activeProfile.rules || [];

            if (rules.length === 0) {
                container.innerHTML = '<div class="empty-state">No rules in active profile</div>';
                return;
            }

            container.innerHTML = rules.map(rule => \`
                <div class="rule-item">
                    <div class="rule-info">
                        <div class="rule-name">\${rule.name}</div>
                        <div class="rule-details">
                            \${rule.operation} | \${rule.scope} | \${rule.decision} | Risk: \${rule.riskLevel} | Priority: \${rule.priority}
                        </div>
                        <div class="rule-details">\${rule.description}</div>
                    </div>
                    <div class="rule-status">
                        <label class="toggle">
                            <input type="checkbox" \${rule.enabled ? 'checked' : ''} 
                                   onchange="toggleRule('\${activeProfile.id}', '\${rule.id}')">
                            <span class="slider"></span>
                        </label>
                        \${!activeProfile.isBuiltIn ? \`<button class="btn danger" onclick="deleteRule('\${activeProfile.id}', '\${rule.id}', '\${rule.name}')">Delete</button>\` : ''}
                    </div>
                </div>
            \`).join('');
        }

        function updateStatistics() {
            const container = document.getElementById('stats-container');
            const stats = currentData.statistics || {};

            container.innerHTML = \`
                <div class="stats-grid">
                    <div class="stat-item">
                        <div class="stat-value">\${stats.totalRequests || 0}</div>
                        <div class="stat-label">Total Requests</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${(stats.averageEvaluationTime || 0).toFixed(1)}ms</div>
                        <div class="stat-label">Avg Eval Time</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${stats.decisionCounts?.allow || 0}</div>
                        <div class="stat-label">Allowed</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${stats.decisionCounts?.deny || 0}</div>
                        <div class="stat-label">Denied</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">\${stats.decisionCounts?.prompt || 0}</div>
                        <div class="stat-label">Prompted</div>
                    </div>
                </div>
            \`;
        }

        // Event handlers
        function activateProfile(profileId, profileName) {
            vscode.postMessage({
                type: 'activateProfile',
                data: { profileId, profileName }
            });
        }

        function deleteProfile(profileId, profileName) {
            vscode.postMessage({
                type: 'deleteProfile',
                data: { profileId, profileName }
            });
        }

        function toggleRule(profileId, ruleId) {
            vscode.postMessage({
                type: 'toggleRule',
                data: { profileId, ruleId }
            });
        }

        function deleteRule(profileId, ruleId, ruleName) {
            vscode.postMessage({
                type: 'deleteRule',
                data: { profileId, ruleId, ruleName }
            });
        }

        function createProfile() {
            vscode.postMessage({ type: 'createProfile' });
        }

        function addRule() {
            if (!currentData.activeProfile) {
                showError('No active profile. Please activate a profile first.');
                return;
            }
            vscode.postMessage({
                type: 'addRule',
                data: { profileId: currentData.activeProfile.id }
            });
        }

        function viewAuditLog() {
            vscode.postMessage({ type: 'viewAuditLog' });
        }

        function viewStatistics() {
            vscode.postMessage({ type: 'viewStatistics' });
        }

        function openSettings() {
            vscode.postMessage({ type: 'openSettings' });
        }

        function toggleService(enabled) {
            vscode.postMessage({
                type: 'updateConfiguration',
                data: { enabled }
            });
        }

        function toggleAudit(auditEnabled) {
            vscode.postMessage({
                type: 'updateConfiguration',
                data: { auditEnabled }
            });
        }

        function toggleCache(cacheEnabled) {
            vscode.postMessage({
                type: 'updateConfiguration',
                data: { cacheEnabled }
            });
        }

        function updateMaxAuditEntries(value) {
            const maxAuditEntries = parseInt(value);
            if (!isNaN(maxAuditEntries) && maxAuditEntries > 0) {
                vscode.postMessage({
                    type: 'updateConfiguration',
                    data: { maxAuditEntries }
                });
            }
        }

        function showError(message) {
            console.error(message);
            // In a real implementation, we'd show this in the UI
        }

        function showRecentDecision(data) {
            // In a real implementation, we'd show recent decisions in the UI
            console.log('Recent permission decision:', data);
        }
    </script>
</body>
</html>`;
	}
}