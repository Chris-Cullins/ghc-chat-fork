/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vi } from 'vitest';

// Setup global mocks and test environment
beforeEach(() => {
	// Clear all mocks before each test
	vi.clearAllMocks();

	// Mock console methods to avoid noise in test output
	global.console = {
		...console,
		log: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as any;
});

// Global DOM setup for drag and drop tests
Object.defineProperty(window, 'DataTransfer', {
	writable: true,
	value: class MockDataTransfer {
		data: Map<string, string> = new Map();
		files: File[] = [];
		types: string[] = [];
		dropEffect: string = 'none';
		effectAllowed: string = 'all';

		getData(format: string): string {
			return this.data.get(format) || '';
		}

		setData(format: string, data: string): void {
			this.data.set(format, data);
			if (!this.types.includes(format)) {
				this.types.push(format);
			}
		}

		clearData(format?: string): void {
			if (format) {
				this.data.delete(format);
				this.types = this.types.filter(t => t !== format);
			} else {
				this.data.clear();
				this.types = [];
			}
		}
	}
});

Object.defineProperty(window, 'DragEvent', {
	writable: true,
	value: class MockDragEvent extends Event {
		dataTransfer: DataTransfer;
		clientX: number;
		clientY: number;
		currentTarget: EventTarget | null = null;

		constructor(type: string, eventInitDict?: DragEventInit) {
			super(type, eventInitDict);
			this.dataTransfer = new DataTransfer();
			this.clientX = eventInitDict?.clientX || 0;
			this.clientY = eventInitDict?.clientY || 0;
		}
	}
});

Object.defineProperty(window, 'File', {
	writable: true,
	value: class MockFile {
		name: string;
		size: number;
		type: string;
		lastModified: number;

		constructor(bits: BlobPart[], name: string, options?: FilePropertyBag) {
			this.name = name;
			this.size = bits.reduce((size, bit) => size + (typeof bit === 'string' ? bit.length : bit.byteLength || 0), 0);
			this.type = options?.type || '';
			this.lastModified = options?.lastModified || Date.now();
		}
	}
});