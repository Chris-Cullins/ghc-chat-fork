/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileQueueService, FileQueueItem, QueueState, FileQueueItemStatus, QueueItemPriority } from '../../../platform/fileQueue/common/fileQueueService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

interface WebviewMessage {
	type: string;
	data?: any;
}

interface AddFileMessage extends WebviewMessage {
	type: 'addFile';
	data: {
		filePath: string;
		priority: QueueItemPriority;
	};
}

interface AddMultipleFilesMessage extends WebviewMessage {
	type: 'addMultipleFiles';
	data: {
		filePaths: string[];
		priority: QueueItemPriority;
	};
}

interface RemoveFileMessage extends WebviewMessage {
	type: 'removeFile';
	data: {
		itemId: string;
	};
}

interface ProcessingControlMessage extends WebviewMessage {
	type: 'startProcessing' | 'pauseProcessing' | 'resumeProcessing' | 'stopProcessing';
	data?: {
		options?: any;
	};
}

interface ClearQueueMessage extends WebviewMessage {
	type: 'clearQueue';
	data: {
		includeProcessing: boolean;
	};
}

interface ReorderQueueMessage extends WebviewMessage {
	type: 'reorderQueue';
	data: {
		itemIds: string[];
	};
}

interface ShowFilePickerMessage extends WebviewMessage {
	type: 'showFilePicker';
	data: {};
}

interface ErrorMessage extends WebviewMessage {
	type: 'error';
	data: {
		message: string;
		severity: string;
		timestamp: string;
	};
}

interface InfoMessage extends WebviewMessage {
	type: 'info';
	data: {
		message: string;
		severity: string;
		timestamp: string;
	};
}

type IncomingMessage = AddFileMessage | AddMultipleFilesMessage | RemoveFileMessage | ProcessingControlMessage | ClearQueueMessage | ReorderQueueMessage | ShowFilePickerMessage | ErrorMessage | InfoMessage;

export class FileQueueWebviewProvider extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewType = 'github.copilot.fileQueue';

	private _view?: vscode.WebviewView;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileQueueService private readonly fileQueueService: IFileQueueService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Listen to queue changes and update webview
		this._register(this.fileQueueService.onQueueChanged(() => {
			this._updateWebview();
		}));

		this._register(this.fileQueueService.onProcessingStateChanged(() => {
			this._updateWebview();
		}));

		this._register(this.fileQueueService.onItemProcessed(() => {
			this._updateWebview();
		}));

		this._register(this.fileQueueService.onError((error) => {
			this._postMessage({
				type: 'error',
				data: {
					message: error.message,
					severity: error.severity,
					timestamp: error.timestamp.toISOString()
				}
			});
		}));
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this.extensionContext.extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage((message: IncomingMessage) => {
			this._handleMessage(message);
		});

		// Send initial data
		this._updateWebview();
	}

	private async _handleMessage(message: IncomingMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'addFile':
					if (message.data?.filePath) {
						try {
							// Validate the file path before adding to queue
							const validation = await this.fileQueueService.validateFile(message.data.filePath);
							if (!validation.valid) {
								this._postMessage({
									type: 'error',
									data: {
										message: `Cannot add file to queue: ${validation.reason || 'Invalid file'}`,
										severity: 'warning',
										timestamp: new Date().toISOString()
									}
								});
								break;
							}

							// Add to queue if validation passes
							const itemId = await this.fileQueueService.addToQueue(
								message.data.filePath,
								message.data.priority || QueueItemPriority.Normal
							);

							this.logService.debug(`Added file to queue: ${message.data.filePath} (ID: ${itemId})`);
						} catch (error) {
							this.logService.error('Failed to add file to queue:', error);
							this._postMessage({
								type: 'error',
								data: {
									message: `Failed to add file to queue: ${error instanceof Error ? error.message : String(error)}`,
									severity: 'error',
									timestamp: new Date().toISOString()
								}
							});
						}
					} else {
						this._postMessage({
							type: 'error',
							data: {
								message: 'No file path provided',
								severity: 'warning',
								timestamp: new Date().toISOString()
							}
						});
					}
					break;

				case 'addMultipleFiles':
					if (message.data?.filePaths && Array.isArray(message.data.filePaths)) {
						try {
							const filePaths = message.data.filePaths.filter(Boolean);
							if (filePaths.length === 0) {
								this._postMessage({
									type: 'error',
									data: {
										message: 'No valid file paths provided',
										severity: 'warning',
										timestamp: new Date().toISOString()
									}
								});
								break;
							}

							// Use the service's addMultipleToQueue method for better batch handling
							const itemIds = await this.fileQueueService.addMultipleToQueue(
								filePaths,
								message.data.priority || QueueItemPriority.Normal
							);

							this.logService.debug(`Added ${itemIds.length} files to queue via drag and drop`);

							// Send success feedback
							this._postMessage({
								type: 'info',
								data: {
									message: `Successfully added ${itemIds.length} file${itemIds.length !== 1 ? 's' : ''} to queue`,
									severity: 'info',
									timestamp: new Date().toISOString()
								}
							});
						} catch (error) {
							this.logService.error('Failed to add multiple files to queue:', error);
							this._postMessage({
								type: 'error',
								data: {
									message: `Failed to add files to queue: ${error instanceof Error ? error.message : String(error)}`,
									severity: 'error',
									timestamp: new Date().toISOString()
								}
							});
						}
					} else {
						this._postMessage({
							type: 'error',
							data: {
								message: 'No file paths provided for batch add',
								severity: 'warning',
								timestamp: new Date().toISOString()
							}
						});
					}
					break;

				case 'removeFile':
					if (message.data?.itemId) {
						await this.fileQueueService.removeFromQueue(message.data.itemId);
					}
					break;

				case 'startProcessing':
					await this.fileQueueService.startProcessing(message.data?.options);
					break;

				case 'pauseProcessing':
					await this.fileQueueService.pauseProcessing();
					break;

				case 'resumeProcessing':
					await this.fileQueueService.resumeProcessing();
					break;

				case 'stopProcessing':
					await this.fileQueueService.stopProcessing();
					break;

				case 'clearQueue':
					await this.fileQueueService.clearQueue(message.data?.includeProcessing || false);
					break;

				case 'reorderQueue':
					if (message.data?.itemIds) {
						await this.fileQueueService.reorderQueue(message.data.itemIds);
					}
					break;

				case 'showFilePicker':
					await this._showFilePicker();
					break;

				case 'error':
					// Log error from webview (e.g., drag and drop errors)
					this.logService.error(`Webview error: ${message.data?.message || 'Unknown error'}`);
					break;

				case 'info':
					// Log info from webview (e.g., drag and drop success)
					this.logService.info(`Webview info: ${message.data?.message || 'Unknown info'}`);
					break;

				default:
					this.logService.warn(`Unknown message type: ${message.type}`);
			}
		} catch (error) {
			this.logService.error(`Error handling webview message:`, error);
			this._postMessage({
				type: 'error',
				data: {
					message: error instanceof Error ? error.message : String(error),
					severity: 'error',
					timestamp: new Date().toISOString()
				}
			});
		}
	}

	private _updateWebview(): void {
		if (!this._view) {
			return;
		}

		const queueState = this.fileQueueService.getQueueState();
		const queueItems = this.fileQueueService.getQueueItems(true);
		const statistics = this.fileQueueService.getQueueStatistics();

		this._postMessage({
			type: 'updateQueue',
			data: {
				state: queueState,
				items: queueItems,
				statistics
			}
		});
	}

	private _postMessage(message: WebviewMessage): void {
		if (this._view) {
			this._view.webview.postMessage(message);
		}
	}

	private async _showFilePicker(): Promise<void> {
		try {
			// Show file picker dialog
			const selectedFiles = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select files to add to processing queue'
			});

			if (!selectedFiles || selectedFiles.length === 0) {
				return;
			}

			// Select priority for the files
			const priorityOptions = [
				{ label: 'Critical', description: 'Process immediately', value: QueueItemPriority.Critical },
				{ label: 'High', description: 'Process before normal items', value: QueueItemPriority.High },
				{ label: 'Normal', description: 'Standard processing order', value: QueueItemPriority.Normal },
				{ label: 'Low', description: 'Process after other items', value: QueueItemPriority.Low }
			];

			const selectedPriority = await vscode.window.showQuickPick(priorityOptions, {
				placeHolder: 'Select priority for the selected files'
			});

			if (!selectedPriority) {
				return;
			}

			// Add files to queue
			const filePaths = selectedFiles.map(uri => uri.fsPath);
			const itemIds = await this.fileQueueService.addMultipleToQueue(
				filePaths,
				selectedPriority.value
			);

			const priorityName = selectedPriority.label.toLowerCase();

			vscode.window.showInformationMessage(
				`Added ${itemIds.length} file${itemIds.length !== 1 ? 's' : ''} to queue with ${priorityName} priority`
			);

			this.logService.debug(`Added ${itemIds.length} files to queue via file picker`);
		} catch (error) {
			this.logService.error('Failed to show file picker:', error);
			vscode.window.showErrorMessage(`Failed to add files to queue: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		// Get the local path to the media files
		const mediaPath = vscode.Uri.joinPath(this.extensionContext.extensionUri, 'src', 'extension', 'fileQueue', 'webview', 'media');
		const mediaUri = webview.asWebviewUri(mediaPath);

		// Get URIs for individual files
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'fileQueue.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'fileQueue.js'));
		const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionContext.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));

		// Generate a nonce for security
		const nonce = this._getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	
	<link href="${codiconsUri}" rel="stylesheet">
	<link href="${styleUri}" rel="stylesheet">
	
	<title>File Queue</title>
</head>
<body>
	<div class="container">
		<!-- Header -->
		<div class="header">
			<h2>
				<span class="codicon codicon-list-ordered"></span>
				File Processing Queue
			</h2>
			<div class="header-stats">
				<span id="queue-size">0 items</span>
				<span id="processing-status">Idle</span>
			</div>
		</div>

		<!-- Controls -->
		<div class="controls">
			<div class="control-group">
				<button id="add-files-btn" class="btn btn-primary" title="Add files to queue">
					<span class="codicon codicon-add"></span>
					Add Files
				</button>
				<button id="clear-queue-btn" class="btn btn-secondary" title="Clear all items from queue">
					<span class="codicon codicon-trash"></span>
					Clear
				</button>
			</div>
			
			<div class="control-group processing-controls">
				<button id="start-btn" class="btn btn-success" title="Start processing queue">
					<span class="codicon codicon-play"></span>
					Start
				</button>
				<button id="pause-btn" class="btn btn-warning" title="Pause processing" disabled>
					<span class="codicon codicon-debug-pause"></span>
					Pause
				</button>
				<button id="stop-btn" class="btn btn-danger" title="Stop processing" disabled>
					<span class="codicon codicon-debug-stop"></span>
					Stop
				</button>
			</div>
		</div>

		<!-- Progress Indicator -->
		<div id="progress-container" class="progress-container" style="display: none;">
			<div class="progress-header">
				<span id="progress-text">Processing...</span>
				<span id="progress-percentage">0%</span>
			</div>
			<div class="progress-bar">
				<div id="progress-fill" class="progress-fill"></div>
			</div>
			<div class="progress-stats">
				<span id="items-processed">0 processed</span>
				<span id="items-remaining">0 remaining</span>
				<span id="estimated-time">ETA: --</span>
			</div>
		</div>

		<!-- Queue Statistics -->
		<div class="statistics">
			<div class="stat-item">
				<span class="stat-label">Total Processed:</span>
				<span id="total-processed" class="stat-value">0</span>
			</div>
			<div class="stat-item">
				<span class="stat-label">Success Rate:</span>
				<span id="success-rate" class="stat-value">--</span>
			</div>
			<div class="stat-item">
				<span class="stat-label">Avg. Time:</span>
				<span id="avg-time" class="stat-value">--</span>
			</div>
		</div>

		<!-- Queue Items -->
		<div class="queue-section">
			<div class="section-header">
				<h3>Queue Items</h3>
				<div class="queue-actions">
					<button id="expand-all-btn" class="btn btn-icon" title="Expand all items">
						<span class="codicon codicon-expand-all"></span>
					</button>
					<button id="collapse-all-btn" class="btn btn-icon" title="Collapse all items">
						<span class="codicon codicon-collapse-all"></span>
					</button>
				</div>
			</div>
			
			<div id="queue-list" class="queue-list">
				<div id="empty-state" class="empty-state">
					<span class="codicon codicon-inbox"></span>
					<p>No files in queue</p>
					<p class="empty-subtitle">Drag files from VS Code Explorer or use "Add Files" button</p>
				</div>
			</div>
		</div>

		<!-- Recent Activity -->
		<div class="recent-section">
			<div class="section-header">
				<h3>Recent Activity</h3>
				<button id="clear-history-btn" class="btn btn-icon" title="Clear history">
					<span class="codicon codicon-clear-all"></span>
				</button>
			</div>
			
			<div id="recent-list" class="recent-list">
				<div id="recent-empty-state" class="empty-state">
					<span class="codicon codicon-history"></span>
					<p>No recent activity</p>
				</div>
			</div>
		</div>
	</div>
	
	<!-- Drag overlay for global drag feedback -->
	<div class="drag-overlay"></div>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private _getNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}
}