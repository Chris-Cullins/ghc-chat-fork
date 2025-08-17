/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Monitors VS Code chat activity by registering a chat participant
 * that can observe when chat responses complete.
 */
export class ChatMonitor extends Disposable {
	private _completionCallbacks = new Map<string, () => void>();
	private _activeChatSessions = new Set<string>();
	private _chatParticipant?: vscode.ChatParticipant;

	constructor(
		private readonly logService: ILogService
	) {
		super();
		this._setupChatMonitoring();
	}

	private _setupChatMonitoring(): void {
		try {
			// Register a lightweight chat participant that monitors chat activity
			this._chatParticipant = vscode.chat.createChatParticipant(
				'github.copilot.filequeue-monitor',
				this._handleChatRequest.bind(this)
			);

			// Set up the participant to be invisible to users
			this._chatParticipant.iconPath = new vscode.ThemeIcon('eye');
			// Note: This participant should not appear in the UI - it's just for monitoring

			this.logService.debug('Chat monitor participant registered');

		} catch (error) {
			this.logService.warn('Failed to register chat monitor participant:', error);
		}
	}

	private async _handleChatRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult> {
		// This participant doesn't actually handle requests - it just monitors
		// Return empty result to indicate it's not handling the request
		return {};
	}

	/**
	 * Register a callback to be called when chat completion is detected
	 */
	registerCompletionCallback(fileId: string, callback: () => void): void {
		this._completionCallbacks.set(fileId, callback);
		this.logService.debug(`Registered completion callback for: ${fileId}`);
	}

	/**
	 * Remove a completion callback
	 */
	removeCompletionCallback(fileId: string): void {
		this._completionCallbacks.delete(fileId);
		this.logService.debug(`Removed completion callback for: ${fileId}`);
	}

	/**
	 * Monitor VS Code's active editor and terminal state to detect chat activity
	 */
	async detectChatActivity(fileId: string): Promise<boolean> {
		try {
			// Strategy: Use VS Code's observable state to detect if chat is working

			// Check 1: Active terminal (chat often creates terminals for code execution)
			const activeTerminal = vscode.window.activeTerminal;
			if (activeTerminal) {
				return true;
			}

			// Check 2: Recently modified documents (chat often creates/modifies files)
			for (const document of vscode.workspace.textDocuments) {
				if (document.isDirty) {
					return true; // Unsaved changes suggest recent activity
				}
			}

			// Check 3: Active output channels (chat might write to output)
			// Note: We can't directly access output channels, but we can check for visible editors

			// Check 4: Window focus and cursor movement
			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor) {
				// If there's an active editor with a cursor, there might be ongoing interaction
				const selection = activeEditor.selection;
				if (!selection.isEmpty) {
					return true; // Text is selected, suggesting interaction
				}
			}

			return false;

		} catch (error) {
			this.logService.debug(`Error detecting chat activity: ${error}`);
			return false;
		}
	}

	/**
	 * Enhanced monitoring that watches VS Code events
	 */
	startMonitoring(fileId: string): void {
		this._activeChatSessions.add(fileId);
		this.logService.debug(`Started monitoring chat session: ${fileId}`);

		// Set up event listeners for VS Code activity
		const disposables: vscode.Disposable[] = [];

		// Monitor terminal creation/changes
		disposables.push(vscode.window.onDidOpenTerminal(terminal => {
			this.logService.debug(`Terminal opened during monitoring: ${terminal.name}`);
		}));

		// Monitor document changes
		disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
			this.logService.debug(`Document changed during monitoring: ${event.document.fileName}`);
		}));

		// Monitor active editor changes
		disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				this.logService.debug(`Active editor changed during monitoring: ${editor.document.fileName}`);
			}
		}));

		// Clean up listeners when session ends
		const cleanup = () => {
			disposables.forEach(d => d.dispose());
			this._activeChatSessions.delete(fileId);
		};

		// Store cleanup function
		const originalCallback = this._completionCallbacks.get(fileId);
		this._completionCallbacks.set(fileId, () => {
			cleanup();
			if (originalCallback) {
				originalCallback();
			}
		});
	}

	/**
	 * Stop monitoring a chat session
	 */
	stopMonitoring(fileId: string): void {
		const callback = this._completionCallbacks.get(fileId);
		if (callback) {
			callback();
		}
		this._activeChatSessions.delete(fileId);
		this._completionCallbacks.delete(fileId);
		this.logService.debug(`Stopped monitoring chat session: ${fileId}`);
	}

	override dispose(): void {
		// Clean up all monitoring
		for (const fileId of this._activeChatSessions) {
			this.stopMonitoring(fileId);
		}

		if (this._chatParticipant) {
			this._chatParticipant.dispose();
		}

		super.dispose();
	}
}