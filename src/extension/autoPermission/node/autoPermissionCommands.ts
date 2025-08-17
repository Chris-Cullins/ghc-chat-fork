/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	ConditionType,
	IAutoPermissionService,
	PermissionDecision,
	PermissionOperation,
	PermissionProfile,
	PermissionRule,
	PermissionScope,
	RiskLevel
} from '../../../platform/autoPermission/common/autoPermissionService';
import { IDialogService } from '../../../platform/dialog/common/dialogService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

export class AutoPermissionCommands extends Disposable {
	constructor(
		@IAutoPermissionService private readonly _autoPermissionService: IAutoPermissionService,
		@IDialogService private readonly _dialogService: IDialogService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		this._registerCommands();
	}

	private _registerCommands(): void {
		// Profile management commands
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.createProfile', () => this.createProfile()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.editProfile', () => this.editProfile()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.deleteProfile', () => this.deleteProfile()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.activateProfile', () => this.activateProfile()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.duplicateProfile', () => this.duplicateProfile()));

		// Rule management commands
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.addRule', () => this.addRule()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.editRule', () => this.editRule()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.deleteRule', () => this.deleteRule()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.testRule', () => this.testRule()));

		// Quick actions
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.addFileRule', (uri: vscode.Uri) => this.addFileRule(uri)));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.quickAllow', (uri: vscode.Uri) => this.quickAllow(uri)));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.quickDeny', (uri: vscode.Uri) => this.quickDeny(uri)));

		// Audit and statistics
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.viewAuditLog', () => this.viewAuditLog()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.exportAuditLog', () => this.exportAuditLog()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.clearAuditLog', () => this.clearAuditLog()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.viewStatistics', () => this.viewStatistics()));

		// Configuration
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.openSettings', () => this.openSettings()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.resetBuiltInProfile', () => this.resetBuiltInProfile()));
		this._register(vscode.commands.registerCommand('github.copilot.autoPermission.getSuggestedRules', () => this.getSuggestedRules()));
	}

	// Profile Management

	async createProfile(): Promise<void> {
		try {
			const name = await vscode.window.showInputBox({
				prompt: 'Enter profile name',
				placeHolder: 'My Custom Profile',
				validateInput: (value) => {
					if (!value || value.trim().length === 0) {
						return 'Profile name is required';
					}
					return null;
				}
			});

			if (!name) return;

			const description = await vscode.window.showInputBox({
				prompt: 'Enter profile description',
				placeHolder: 'Description of what this profile does'
			});

			const securityLevel = await vscode.window.showQuickPick([
				{ label: 'Conservative', description: 'Strict security, prompts for most operations', value: 'conservative' },
				{ label: 'Balanced', description: 'Balanced security and convenience', value: 'balanced' },
				{ label: 'Permissive', description: 'Allows most operations automatically', value: 'permissive' },
				{ label: 'Custom', description: 'Custom configuration', value: 'custom' }
			], {
				placeHolder: 'Select security level'
			});

			if (!securityLevel) return;

			const defaultDecision = await vscode.window.showQuickPick([
				{ label: 'Allow', description: 'Default to allowing operations', value: PermissionDecision.Allow },
				{ label: 'Deny', description: 'Default to denying operations', value: PermissionDecision.Deny },
				{ label: 'Prompt', description: 'Default to prompting user', value: PermissionDecision.Prompt }
			], {
				placeHolder: 'Select default decision when no rules match'
			});

			if (!defaultDecision) return;

			const profileId = await this._autoPermissionService.createProfile({
				name: name.trim(),
				description: description?.trim() || '',
				isBuiltIn: false,
				isActive: false,
				isDefault: false,
				rules: [],
				defaultDecision: defaultDecision.value,
				securityLevel: securityLevel.value as any
			});

			const activate = await vscode.window.showInformationMessage(
				`Profile "${name}" created successfully. Activate it now?`,
				'Yes', 'No'
			);

			if (activate === 'Yes') {
				await this._autoPermissionService.setActiveProfile(profileId);
				vscode.window.showInformationMessage(`Profile "${name}" is now active.`);
			}

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to create profile: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to create profile', error);
		}
	}

	async editProfile(): Promise<void> {
		try {
			const profiles = this._autoPermissionService.getProfiles().filter(p => !p.isBuiltIn);
			if (profiles.length === 0) {
				vscode.window.showWarningMessage('No custom profiles to edit. Built-in profiles cannot be modified.');
				return;
			}

			const selectedProfile = await vscode.window.showQuickPick(
				profiles.map(p => ({
					label: p.name,
					description: p.description,
					detail: p.isActive ? 'Currently active' : '',
					profile: p
				})),
				{ placeHolder: 'Select profile to edit' }
			);

			if (!selectedProfile) return;

			// For now, just allow editing name and description
			const newName = await vscode.window.showInputBox({
				prompt: 'Enter new profile name',
				value: selectedProfile.profile.name,
				validateInput: (value) => {
					if (!value || value.trim().length === 0) {
						return 'Profile name is required';
					}
					return null;
				}
			});

			if (newName === undefined) return;

			const newDescription = await vscode.window.showInputBox({
				prompt: 'Enter new profile description',
				value: selectedProfile.profile.description
			});

			if (newDescription === undefined) return;

			await this._autoPermissionService.updateProfile(selectedProfile.profile.id, {
				name: newName.trim(),
				description: newDescription.trim()
			});

			vscode.window.showInformationMessage(`Profile "${newName}" updated successfully.`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to edit profile: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to edit profile', error);
		}
	}

	async deleteProfile(): Promise<void> {
		try {
			const profiles = this._autoPermissionService.getProfiles().filter(p => !p.isBuiltIn);
			if (profiles.length === 0) {
				vscode.window.showWarningMessage('No custom profiles to delete. Built-in profiles cannot be deleted.');
				return;
			}

			const selectedProfile = await vscode.window.showQuickPick(
				profiles.map(p => ({
					label: p.name,
					description: p.description,
					detail: p.isActive ? 'Currently active' : '',
					profile: p
				})),
				{ placeHolder: 'Select profile to delete' }
			);

			if (!selectedProfile) return;

			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to delete profile "${selectedProfile.profile.name}"? This action cannot be undone.`,
				'Delete', 'Cancel'
			);

			if (confirm !== 'Delete') return;

			await this._autoPermissionService.deleteProfile(selectedProfile.profile.id);
			vscode.window.showInformationMessage(`Profile "${selectedProfile.profile.name}" deleted successfully.`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to delete profile: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to delete profile', error);
		}
	}

	async activateProfile(): Promise<void> {
		try {
			const profiles = this._autoPermissionService.getProfiles();
			const selectedProfile = await vscode.window.showQuickPick(
				profiles.map(p => ({
					label: p.name,
					description: p.description,
					detail: p.isActive ? 'Currently active' : (p.isBuiltIn ? 'Built-in' : 'Custom'),
					profile: p
				})),
				{ placeHolder: 'Select profile to activate' }
			);

			if (!selectedProfile) return;

			if (selectedProfile.profile.isActive) {
				vscode.window.showInformationMessage(`Profile "${selectedProfile.profile.name}" is already active.`);
				return;
			}

			await this._autoPermissionService.setActiveProfile(selectedProfile.profile.id);
			vscode.window.showInformationMessage(`Profile "${selectedProfile.profile.name}" is now active.`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to activate profile: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to activate profile', error);
		}
	}

	async duplicateProfile(): Promise<void> {
		try {
			const profiles = this._autoPermissionService.getProfiles();
			const selectedProfile = await vscode.window.showQuickPick(
				profiles.map(p => ({
					label: p.name,
					description: p.description,
					detail: p.isBuiltIn ? 'Built-in' : 'Custom',
					profile: p
				})),
				{ placeHolder: 'Select profile to duplicate' }
			);

			if (!selectedProfile) return;

			const newName = await vscode.window.showInputBox({
				prompt: 'Enter name for the duplicated profile',
				value: `${selectedProfile.profile.name} (Copy)`,
				validateInput: (value) => {
					if (!value || value.trim().length === 0) {
						return 'Profile name is required';
					}
					return null;
				}
			});

			if (!newName) return;

			const profileId = await this._autoPermissionService.createProfile({
				...selectedProfile.profile,
				name: newName.trim(),
				isBuiltIn: false,
				isActive: false,
				isDefault: false
			});

			vscode.window.showInformationMessage(`Profile "${newName}" created successfully as a copy of "${selectedProfile.profile.name}".`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to duplicate profile: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to duplicate profile', error);
		}
	}

	// Rule Management

	async addRule(): Promise<void> {
		try {
			const profiles = this._autoPermissionService.getProfiles().filter(p => !p.isBuiltIn);
			if (profiles.length === 0) {
				vscode.window.showWarningMessage('No custom profiles available. Create a custom profile first.');
				return;
			}

			const selectedProfile = await vscode.window.showQuickPick(
				profiles.map(p => ({
					label: p.name,
					description: p.description,
					profile: p
				})),
				{ placeHolder: 'Select profile to add rule to' }
			);

			if (!selectedProfile) return;

			const rule = await this._collectRuleDetails();
			if (!rule) return;

			await this._autoPermissionService.addRule(selectedProfile.profile.id, rule);
			vscode.window.showInformationMessage(`Rule "${rule.name}" added to profile "${selectedProfile.profile.name}".`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to add rule: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to add rule', error);
		}
	}

	async editRule(): Promise<void> {
		// Implementation would be similar to addRule but for editing
		vscode.window.showInformationMessage('Rule editing UI would be implemented here');
	}

	async deleteRule(): Promise<void> {
		// Implementation for deleting rules
		vscode.window.showInformationMessage('Rule deletion UI would be implemented here');
	}

	async testRule(): Promise<void> {
		// Implementation for testing rules
		vscode.window.showInformationMessage('Rule testing UI would be implemented here');
	}

	// Quick Actions

	async addFileRule(uri: vscode.Uri): Promise<void> {
		try {
			const activeProfile = this._autoPermissionService.getActiveProfile();
			if (!activeProfile || activeProfile.isBuiltIn) {
				vscode.window.showWarningMessage('No active custom profile. Create or activate a custom profile first.');
				return;
			}

			const operation = await vscode.window.showQuickPick([
				{ label: 'Read', value: PermissionOperation.Read },
				{ label: 'Write', value: PermissionOperation.Write },
				{ label: 'Execute', value: PermissionOperation.Execute },
				{ label: 'Delete', value: PermissionOperation.Delete },
				{ label: 'Create', value: PermissionOperation.Create },
				{ label: 'Analyze', value: PermissionOperation.Analyze },
				{ label: 'Edit', value: PermissionOperation.Edit }
			], {
				placeHolder: 'Select operation type'
			});

			if (!operation) return;

			const decision = await vscode.window.showQuickPick([
				{ label: 'Allow', value: PermissionDecision.Allow },
				{ label: 'Deny', value: PermissionDecision.Deny },
				{ label: 'Prompt', value: PermissionDecision.Prompt }
			], {
				placeHolder: 'Select permission decision'
			});

			if (!decision) return;

			const fileExtension = this._getFileExtension(uri.path);
			const fileName = this._getFileName(uri.path);

			const rule: Omit<PermissionRule, 'id' | 'createdAt' | 'modifiedAt'> = {
				name: `${decision.label} ${operation.label} for ${fileExtension || fileName} files`,
				description: `Auto-generated rule for ${operation.value} operations on ${fileExtension || fileName} files`,
				operation: operation.value,
				scope: PermissionScope.File,
				decision: decision.value,
				riskLevel: decision.value === PermissionDecision.Allow ? RiskLevel.Low : RiskLevel.Medium,
				conditions: fileExtension ? [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: fileExtension
				}] : [{
					type: ConditionType.FilePath,
					operator: 'equals',
					value: uri.path
				}],
				priority: 100,
				enabled: true,
				auditRequired: true
			};

			await this._autoPermissionService.addRule(activeProfile.id, rule);
			vscode.window.showInformationMessage(`Rule created: ${rule.name}`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to create file rule: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to create file rule', error);
		}
	}

	async quickAllow(uri: vscode.Uri): Promise<void> {
		try {
			const operation = PermissionOperation.Read; // Default to read for quick actions
			await this._autoPermissionService.manuallyApprove({
				uri,
				operation,
				scope: PermissionScope.File,
				requestingTool: 'manual',
				timestamp: new Date()
			}, true);

			vscode.window.showInformationMessage(`File access allowed and rule created for ${this._getFileName(uri.path)}`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to allow file access: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to allow file access', error);
		}
	}

	async quickDeny(uri: vscode.Uri): Promise<void> {
		try {
			const operation = PermissionOperation.Read; // Default to read for quick actions
			await this._autoPermissionService.manuallyDeny({
				uri,
				operation,
				scope: PermissionScope.File,
				requestingTool: 'manual',
				timestamp: new Date()
			}, true);

			vscode.window.showInformationMessage(`File access denied and rule created for ${this._getFileName(uri.path)}`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to deny file access: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to deny file access', error);
		}
	}

	// Audit and Statistics

	async viewAuditLog(): Promise<void> {
		try {
			const auditEntries = this._autoPermissionService.getAuditLog(100);
			if (auditEntries.length === 0) {
				vscode.window.showInformationMessage('No audit log entries found.');
				return;
			}

			// Create and show audit log in a new document
			const content = this._formatAuditLog(auditEntries);
			const doc = await vscode.workspace.openTextDocument({
				content,
				language: 'plaintext'
			});
			await vscode.window.showTextDocument(doc);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to view audit log: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to view audit log', error);
		}
	}

	async exportAuditLog(): Promise<void> {
		try {
			const format = await vscode.window.showQuickPick([
				{ label: 'JSON', value: 'json' },
				{ label: 'CSV', value: 'csv' }
			], {
				placeHolder: 'Select export format'
			});

			if (!format) return;

			const data = await this._autoPermissionService.exportAuditLog(format.value as 'json' | 'csv');

			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(`copilot-permission-audit.${format.value}`),
				filters: {
					[format.label]: [format.value]
				}
			});

			if (!uri) return;

			await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf8'));
			vscode.window.showInformationMessage(`Audit log exported to ${uri.fsPath}`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to export audit log: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to export audit log', error);
		}
	}

	async clearAuditLog(): Promise<void> {
		try {
			const confirm = await vscode.window.showWarningMessage(
				'Are you sure you want to clear the audit log? This action cannot be undone.',
				'Clear', 'Cancel'
			);

			if (confirm !== 'Clear') return;

			await this._autoPermissionService.clearAuditLog();
			vscode.window.showInformationMessage('Audit log cleared successfully.');

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to clear audit log: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to clear audit log', error);
		}
	}

	async viewStatistics(): Promise<void> {
		try {
			const stats = this._autoPermissionService.getStatistics();
			const content = this._formatStatistics(stats);

			const doc = await vscode.workspace.openTextDocument({
				content,
				language: 'plaintext'
			});
			await vscode.window.showTextDocument(doc);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to view statistics: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to view statistics', error);
		}
	}

	// Configuration

	async openSettings(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot.autoPermission');
	}

	async resetBuiltInProfile(): Promise<void> {
		try {
			const builtInProfiles = this._autoPermissionService.getProfiles().filter(p => p.isBuiltIn);
			const selectedProfile = await vscode.window.showQuickPick(
				builtInProfiles.map(p => ({
					label: p.name,
					description: p.description,
					profile: p
				})),
				{ placeHolder: 'Select built-in profile to reset' }
			);

			if (!selectedProfile) return;

			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to reset "${selectedProfile.profile.name}" to its default configuration?`,
				'Reset', 'Cancel'
			);

			if (confirm !== 'Reset') return;

			await this._autoPermissionService.resetBuiltInProfile(selectedProfile.profile.id);
			vscode.window.showInformationMessage(`Profile "${selectedProfile.profile.name}" reset successfully.`);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to reset profile: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to reset profile', error);
		}
	}

	async getSuggestedRules(): Promise<void> {
		try {
			const suggestedRules = await this._autoPermissionService.getSuggestedRules();
			if (suggestedRules.length === 0) {
				vscode.window.showInformationMessage('No rule suggestions available. Use the system more to generate suggestions.');
				return;
			}

			const content = this._formatSuggestedRules(suggestedRules);
			const doc = await vscode.workspace.openTextDocument({
				content,
				language: 'plaintext'
			});
			await vscode.window.showTextDocument(doc);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to get suggested rules: ${error}`);
			this._logService.error('AutoPermissionCommands: Failed to get suggested rules', error);
		}
	}

	// Helper Methods

	private async _collectRuleDetails(): Promise<Omit<PermissionRule, 'id' | 'createdAt' | 'modifiedAt'> | null> {
		const name = await vscode.window.showInputBox({
			prompt: 'Enter rule name',
			placeHolder: 'Allow reading text files',
			validateInput: (value) => {
				if (!value || value.trim().length === 0) {
					return 'Rule name is required';
				}
				return null;
			}
		});

		if (!name) return null;

		const description = await vscode.window.showInputBox({
			prompt: 'Enter rule description',
			placeHolder: 'Allows reading of common text file types'
		});

		const operation = await vscode.window.showQuickPick([
			{ label: 'Read', value: PermissionOperation.Read },
			{ label: 'Write', value: PermissionOperation.Write },
			{ label: 'Execute', value: PermissionOperation.Execute },
			{ label: 'Delete', value: PermissionOperation.Delete },
			{ label: 'Create', value: PermissionOperation.Create },
			{ label: 'Analyze', value: PermissionOperation.Analyze },
			{ label: 'Edit', value: PermissionOperation.Edit }
		], {
			placeHolder: 'Select operation type'
		});

		if (!operation) return null;

		const scope = await vscode.window.showQuickPick([
			{ label: 'File', value: PermissionScope.File },
			{ label: 'Directory', value: PermissionScope.Directory },
			{ label: 'Workspace', value: PermissionScope.Workspace },
			{ label: 'System', value: PermissionScope.System }
		], {
			placeHolder: 'Select operation scope'
		});

		if (!scope) return null;

		const decision = await vscode.window.showQuickPick([
			{ label: 'Allow', value: PermissionDecision.Allow },
			{ label: 'Deny', value: PermissionDecision.Deny },
			{ label: 'Prompt', value: PermissionDecision.Prompt }
		], {
			placeHolder: 'Select permission decision'
		});

		if (!decision) return null;

		const riskLevel = await vscode.window.showQuickPick([
			{ label: 'Low', value: RiskLevel.Low },
			{ label: 'Medium', value: RiskLevel.Medium },
			{ label: 'High', value: RiskLevel.High },
			{ label: 'Critical', value: RiskLevel.Critical }
		], {
			placeHolder: 'Select risk level'
		});

		if (!riskLevel) return null;

		const priority = await vscode.window.showInputBox({
			prompt: 'Enter rule priority (1-1000, higher numbers processed first)',
			value: '100',
			validateInput: (value) => {
				const num = parseInt(value);
				if (isNaN(num) || num < 1 || num > 1000) {
					return 'Priority must be a number between 1 and 1000';
				}
				return null;
			}
		});

		if (!priority) return null;

		return {
			name: name.trim(),
			description: description?.trim() || '',
			operation: operation.value,
			scope: scope.value,
			decision: decision.value,
			riskLevel: riskLevel.value,
			conditions: [], // Would need more UI to collect conditions
			priority: parseInt(priority),
			enabled: true,
			auditRequired: true
		};
	}

	private _getFileExtension(path: string): string {
		const lastDot = path.lastIndexOf('.');
		return lastDot === -1 ? '' : path.substring(lastDot + 1).toLowerCase();
	}

	private _getFileName(path: string): string {
		const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return lastSlash === -1 ? path : path.substring(lastSlash + 1);
	}

	private _formatAuditLog(entries: any[]): string {
		const lines = [
			'=== Copilot Auto-Permission Audit Log ===',
			`Generated: ${new Date().toISOString()}`,
			`Total entries: ${entries.length}`,
			'',
			'Format: [Timestamp] Operation on File -> Decision (Tool) [Risk Level]',
			'',
			...entries.map(entry => {
				const timestamp = entry.context.timestamp.toISOString();
				const operation = entry.context.operation;
				const file = this._getFileName(entry.context.uri.path);
				const decision = entry.result.decision;
				const tool = entry.context.requestingTool;
				const risk = entry.result.riskLevel;
				const executed = entry.executed ? '✓' : '✗';

				return `[${timestamp}] ${operation} on ${file} -> ${decision} (${tool}) [${risk}] ${executed}`;
			})
		];

		return lines.join('\n');
	}

	private _formatStatistics(stats: any): string {
		const lines = [
			'=== Copilot Auto-Permission Statistics ===',
			`Generated: ${new Date().toISOString()}`,
			`Period: ${stats.periodStart.toISOString()} to ${stats.periodEnd.toISOString()}`,
			'',
			`Total Requests: ${stats.totalRequests}`,
			`Average Evaluation Time: ${stats.averageEvaluationTime.toFixed(2)}ms`,
			'',
			'Decisions:',
			...Object.entries(stats.decisionCounts).map(([decision, count]) => `  ${decision}: ${count}`),
			'',
			'Operations:',
			...Object.entries(stats.operationCounts).map(([operation, count]) => `  ${operation}: ${count}`),
			'',
			'Risk Levels:',
			...Object.entries(stats.riskLevelCounts).map(([risk, count]) => `  ${risk}: ${count}`),
			'',
			'Top Rules:',
			...stats.topRules.map((rule: any, index: number) => `  ${index + 1}. ${rule.ruleId}: ${rule.count} uses`)
		];

		return lines.join('\n');
	}

	private _formatSuggestedRules(rules: PermissionRule[]): string {
		const lines = [
			'=== Suggested Permission Rules ===',
			`Generated: ${new Date().toISOString()}`,
			`Total suggestions: ${rules.length}`,
			'',
			...rules.map((rule, index) => [
				`${index + 1}. ${rule.name}`,
				`   Description: ${rule.description}`,
				`   Operation: ${rule.operation} | Scope: ${rule.scope} | Decision: ${rule.decision}`,
				`   Risk Level: ${rule.riskLevel} | Priority: ${rule.priority}`,
				`   Conditions: ${rule.conditions.length > 0 ? rule.conditions.map(c => `${c.type}=${c.value}`).join(', ') : 'None'}`,
				''
			]).flat()
		];

		return lines.join('\n');
	}
}