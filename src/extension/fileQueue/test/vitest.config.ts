/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		globals: true,
		environment: 'jsdom',
		setupFiles: ['./setup.ts'],
		include: [
			'**/*.test.ts',
			'**/*.spec.ts'
		],
		exclude: [
			'**/node_modules/**',
			'**/dist/**'
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			exclude: [
				'**/node_modules/**',
				'**/test/**',
				'**/*.d.ts'
			]
		}
	},
	resolve: {
		alias: {
			'@': resolve(__dirname, '../'),
			'vscode': resolve(__dirname, './mocks/vscode.ts')
		}
	}
});