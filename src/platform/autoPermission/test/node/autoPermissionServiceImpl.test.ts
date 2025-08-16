/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createPlatformServices } from '../../../test/node/services';
import {
	ConditionType,
	IAutoPermissionService,
	PermissionAuditEntry,
	PermissionContext,
	PermissionDecision,
	PermissionOperation,
	PermissionProfile,
	PermissionRule,
	PermissionScope,
	RiskLevel
} from '../../common/autoPermissionService';
import { AutoPermissionServiceImpl } from '../../node/autoPermissionServiceImpl';

suite('AutoPermissionServiceImpl', () => {

	const store = new DisposableStore();
	let instaService: IInstantiationService;
	let autoPermissionService: IAutoPermissionService;

	setup(function () {
		const services = createPlatformServices();
		const accessor = services.createTestingAccessor();
		instaService = accessor.get(IInstantiationService);
		store.add(instaService);

		autoPermissionService = instaService.createInstance(AutoPermissionServiceImpl);
		store.add(autoPermissionService);
	});

	teardown(function () {
		store.clear();
	});

	suite('Profile Management', () => {

		test('should create and retrieve profiles', async function () {
			const profileData = {
				name: 'Test Profile',
				description: 'A test permission profile',
				isBuiltIn: false,
				isActive: false,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Prompt,
				securityLevel: 'custom' as const
			};

			const profileId = await autoPermissionService.createProfile(profileData);
			assert.ok(profileId);

			const retrievedProfile = autoPermissionService.getProfile(profileId);
			assert.ok(retrievedProfile);
			assert.strictEqual(retrievedProfile.name, profileData.name);
			assert.strictEqual(retrievedProfile.description, profileData.description);
			assert.strictEqual(retrievedProfile.securityLevel, profileData.securityLevel);
			assert.strictEqual(retrievedProfile.version, 1);
		});

		test('should update profile correctly', async function () {
			const profileData = {
				name: 'Test Profile',
				description: 'Original description',
				isBuiltIn: false,
				isActive: false,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Prompt,
				securityLevel: 'custom' as const
			};

			const profileId = await autoPermissionService.createProfile(profileData);
			const originalProfile = autoPermissionService.getProfile(profileId)!;

			await autoPermissionService.updateProfile(profileId, {
				description: 'Updated description',
				defaultDecision: PermissionDecision.Allow
			});

			const updatedProfile = autoPermissionService.getProfile(profileId)!;
			assert.strictEqual(updatedProfile.description, 'Updated description');
			assert.strictEqual(updatedProfile.defaultDecision, PermissionDecision.Allow);
			assert.strictEqual(updatedProfile.version, originalProfile.version + 1);
			assert.ok(updatedProfile.modifiedAt > originalProfile.modifiedAt);
		});

		test('should prevent modification of built-in profiles', async function () {
			// Initialize built-in profiles
			await autoPermissionService.initializeBuiltInProfiles();

			const profiles = autoPermissionService.getProfiles();
			const builtInProfile = profiles.find(p => p.isBuiltIn);
			assert.ok(builtInProfile, 'Should have at least one built-in profile');

			try {
				await autoPermissionService.updateProfile(builtInProfile.id, {
					rules: [{
						id: 'test',
						name: 'Test Rule',
						description: 'Test',
						operation: PermissionOperation.Read,
						scope: PermissionScope.File,
						decision: PermissionDecision.Allow,
						riskLevel: RiskLevel.Low,
						conditions: [],
						priority: 100,
						enabled: true,
						auditRequired: false,
						createdAt: new Date(),
						modifiedAt: new Date()
					}]
				});
				assert.fail('Should not allow modification of built-in profile rules');
			} catch (error) {
				assert.ok(error.message.includes('Cannot modify rules of built-in profiles'));
			}
		});

		test('should set and get active profile', async function () {
			const profileData = {
				name: 'Active Test Profile',
				description: 'A test profile to set as active',
				isBuiltIn: false,
				isActive: false,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Allow,
				securityLevel: 'custom' as const
			};

			const profileId = await autoPermissionService.createProfile(profileData);
			await autoPermissionService.setActiveProfile(profileId);

			const activeProfile = autoPermissionService.getActiveProfile();
			assert.ok(activeProfile);
			assert.strictEqual(activeProfile.id, profileId);
			assert.strictEqual(activeProfile.isActive, true);
		});

		test('should delete custom profiles but not built-in ones', async function () {
			// Create custom profile
			const profileData = {
				name: 'Deletable Profile',
				description: 'This profile can be deleted',
				isBuiltIn: false,
				isActive: false,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Prompt,
				securityLevel: 'custom' as const
			};

			const profileId = await autoPermissionService.createProfile(profileData);
			assert.ok(autoPermissionService.getProfile(profileId));

			await autoPermissionService.deleteProfile(profileId);
			assert.strictEqual(autoPermissionService.getProfile(profileId), undefined);

			// Try to delete built-in profile
			await autoPermissionService.initializeBuiltInProfiles();
			const profiles = autoPermissionService.getProfiles();
			const builtInProfile = profiles.find(p => p.isBuiltIn);

			if (builtInProfile) {
				try {
					await autoPermissionService.deleteProfile(builtInProfile.id);
					assert.fail('Should not allow deletion of built-in profiles');
				} catch (error) {
					assert.ok(error.message.includes('Cannot delete built-in profiles'));
				}
			}
		});

	});

	suite('Rule Management', () => {

		let profileId: string;

		setup(async function () {
			const profileData = {
				name: 'Test Profile for Rules',
				description: 'A test profile for rule management',
				isBuiltIn: false,
				isActive: false,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Prompt,
				securityLevel: 'custom' as const
			};

			profileId = await autoPermissionService.createProfile(profileData);
		});

		test('should add rule to profile', async function () {
			const ruleData = {
				name: 'Test Rule',
				description: 'A test permission rule',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals' as const,
					value: 'txt'
				}],
				priority: 100,
				enabled: true,
				auditRequired: false
			};

			const ruleId = await autoPermissionService.addRule(profileId, ruleData);
			assert.ok(ruleId);

			const rules = autoPermissionService.getRules(profileId);
			assert.strictEqual(rules.length, 1);
			assert.strictEqual(rules[0].name, ruleData.name);
			assert.strictEqual(rules[0].id, ruleId);
		});

		test('should update rule correctly', async function () {
			const ruleData = {
				name: 'Updatable Rule',
				description: 'Original description',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [],
				priority: 100,
				enabled: true,
				auditRequired: false
			};

			const ruleId = await autoPermissionService.addRule(profileId, ruleData);

			await autoPermissionService.updateRule(profileId, ruleId, {
				description: 'Updated description',
				priority: 200,
				enabled: false
			});

			const rules = autoPermissionService.getRules(profileId);
			const updatedRule = rules.find(r => r.id === ruleId)!;
			assert.strictEqual(updatedRule.description, 'Updated description');
			assert.strictEqual(updatedRule.priority, 200);
			assert.strictEqual(updatedRule.enabled, false);
		});

		test('should delete rule from profile', async function () {
			const ruleData = {
				name: 'Deletable Rule',
				description: 'This rule will be deleted',
				operation: PermissionOperation.Write,
				scope: PermissionScope.File,
				decision: PermissionDecision.Deny,
				riskLevel: RiskLevel.High,
				conditions: [],
				priority: 50,
				enabled: true,
				auditRequired: true
			};

			const ruleId = await autoPermissionService.addRule(profileId, ruleData);
			assert.strictEqual(autoPermissionService.getRules(profileId).length, 1);

			await autoPermissionService.deleteRule(profileId, ruleId);
			assert.strictEqual(autoPermissionService.getRules(profileId).length, 0);
		});

		test('should validate rules correctly', function () {
			const validRule: PermissionRule = {
				id: 'test',
				name: 'Valid Rule',
				description: 'A valid permission rule',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: 'txt'
				}],
				priority: 100,
				enabled: true,
				auditRequired: false,
				createdAt: new Date(),
				modifiedAt: new Date()
			};

			const validation = autoPermissionService.validateRule(validRule);
			assert.strictEqual(validation.valid, true);
			assert.strictEqual(validation.errors.length, 0);

			// Test invalid rule
			const invalidRule: PermissionRule = {
				...validRule,
				name: '', // Invalid: empty name
				priority: -1, // Invalid: negative priority
				conditions: [] // Invalid: no conditions
			};

			const invalidValidation = autoPermissionService.validateRule(invalidRule);
			assert.strictEqual(invalidValidation.valid, false);
			assert.ok(invalidValidation.errors.length > 0);
		});

	});

	suite('Permission Evaluation', () => {

		let profileId: string;

		setup(async function () {
			const profileData = {
				name: 'Evaluation Test Profile',
				description: 'Profile for testing permission evaluation',
				isBuiltIn: false,
				isActive: true,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Prompt,
				securityLevel: 'custom' as const
			};

			profileId = await autoPermissionService.createProfile(profileData);
			await autoPermissionService.setActiveProfile(profileId);
		});

		test('should evaluate permission with matching rule', async function () {
			// Add rule that allows reading .txt files
			await autoPermissionService.addRule(profileId, {
				name: 'Allow TXT Read',
				description: 'Allow reading text files',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: 'txt'
				}],
				priority: 100,
				enabled: true,
				auditRequired: false
			});

			const context: PermissionContext = {
				uri: URI.file('/test/file.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const result = await autoPermissionService.evaluatePermission(context);
			assert.strictEqual(result.decision, PermissionDecision.Allow);
			assert.ok(result.matchedRule);
			assert.strictEqual(result.matchedRule.name, 'Allow TXT Read');
		});

		test('should use default decision when no rules match', async function () {
			const context: PermissionContext = {
				uri: URI.file('/test/file.xyz'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const result = await autoPermissionService.evaluatePermission(context);
			assert.strictEqual(result.decision, PermissionDecision.Prompt); // Default for this profile
			assert.strictEqual(result.matchedRule, undefined);
		});

		test('should respect rule priority order', async function () {
			// Add high priority deny rule
			await autoPermissionService.addRule(profileId, {
				name: 'High Priority Deny',
				description: 'High priority rule that denies',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Deny,
				riskLevel: RiskLevel.High,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: 'txt'
				}],
				priority: 200,
				enabled: true,
				auditRequired: true
			});

			// Add lower priority allow rule
			await autoPermissionService.addRule(profileId, {
				name: 'Low Priority Allow',
				description: 'Low priority rule that allows',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: 'txt'
				}],
				priority: 100,
				enabled: true,
				auditRequired: false
			});

			const context: PermissionContext = {
				uri: URI.file('/test/file.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const result = await autoPermissionService.evaluatePermission(context);
			assert.strictEqual(result.decision, PermissionDecision.Deny);
			assert.strictEqual(result.matchedRule?.name, 'High Priority Deny');
		});

		test('should evaluate file extension conditions correctly', async function () {
			// Test exact match
			await autoPermissionService.addRule(profileId, {
				name: 'JS Files Allow',
				description: 'Allow JavaScript files',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: ['js', 'ts']
				}],
				priority: 100,
				enabled: true,
				auditRequired: false
			});

			const jsContext: PermissionContext = {
				uri: URI.file('/test/script.js'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const tsContext: PermissionContext = {
				uri: URI.file('/test/script.ts'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const pyContext: PermissionContext = {
				uri: URI.file('/test/script.py'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const jsResult = await autoPermissionService.evaluatePermission(jsContext);
			const tsResult = await autoPermissionService.evaluatePermission(tsContext);
			const pyResult = await autoPermissionService.evaluatePermission(pyContext);

			assert.strictEqual(jsResult.decision, PermissionDecision.Allow);
			assert.strictEqual(tsResult.decision, PermissionDecision.Allow);
			assert.strictEqual(pyResult.decision, PermissionDecision.Prompt); // Default
		});

		test('should evaluate file path conditions correctly', async function () {
			await autoPermissionService.addRule(profileId, {
				name: 'Test Directory Allow',
				description: 'Allow access to test directory',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FilePath,
					operator: 'startsWith',
					value: '/test/'
				}],
				priority: 100,
				enabled: true,
				auditRequired: false
			});

			const testContext: PermissionContext = {
				uri: URI.file('/test/somefile.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const prodContext: PermissionContext = {
				uri: URI.file('/prod/somefile.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const testResult = await autoPermissionService.evaluatePermission(testContext);
			const prodResult = await autoPermissionService.evaluatePermission(prodContext);

			assert.strictEqual(testResult.decision, PermissionDecision.Allow);
			assert.strictEqual(prodResult.decision, PermissionDecision.Prompt);
		});

		test('should handle negated conditions', async function () {
			await autoPermissionService.addRule(profileId, {
				name: 'Not Exe Deny',
				description: 'Deny all non-executable files',
				operation: PermissionOperation.Write,
				scope: PermissionScope.File,
				decision: PermissionDecision.Deny,
				riskLevel: RiskLevel.High,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: 'exe',
					negate: true
				}],
				priority: 100,
				enabled: true,
				auditRequired: true
			});

			const txtContext: PermissionContext = {
				uri: URI.file('/test/file.txt'),
				operation: PermissionOperation.Write,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const exeContext: PermissionContext = {
				uri: URI.file('/test/program.exe'),
				operation: PermissionOperation.Write,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const txtResult = await autoPermissionService.evaluatePermission(txtContext);
			const exeResult = await autoPermissionService.evaluatePermission(exeContext);

			assert.strictEqual(txtResult.decision, PermissionDecision.Deny); // Negated condition matches
			assert.strictEqual(exeResult.decision, PermissionDecision.Prompt); // Negated condition doesn't match
		});

		test('should check wouldAutoApprove correctly', async function () {
			await autoPermissionService.addRule(profileId, {
				name: 'Auto Approve MD',
				description: 'Auto approve markdown files',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: 'md'
				}],
				priority: 100,
				enabled: true,
				auditRequired: false
			});

			const mdContext: PermissionContext = {
				uri: URI.file('/test/readme.md'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const txtContext: PermissionContext = {
				uri: URI.file('/test/file.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const mdApproved = await autoPermissionService.wouldAutoApprove(mdContext);
			const txtApproved = await autoPermissionService.wouldAutoApprove(txtContext);

			assert.strictEqual(mdApproved, true);
			assert.strictEqual(txtApproved, false);
		});

	});

	suite('Audit and Logging', () => {

		let profileId: string;

		setup(async function () {
			const profileData = {
				name: 'Audit Test Profile',
				description: 'Profile for testing audit functionality',
				isBuiltIn: false,
				isActive: true,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Allow,
				securityLevel: 'custom' as const
			};

			profileId = await autoPermissionService.createProfile(profileData);
			await autoPermissionService.setActiveProfile(profileId);
		});

		test('should log permission decisions to audit log', async function () {
			const context: PermissionContext = {
				uri: URI.file('/test/file.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const initialLogLength = autoPermissionService.getAuditLog().length;

			await autoPermissionService.evaluatePermission(context);

			const finalLogLength = autoPermissionService.getAuditLog().length;
			assert.strictEqual(finalLogLength, initialLogLength + 1);

			const auditEntries = autoPermissionService.getAuditLog(1);
			assert.strictEqual(auditEntries.length, 1);
			assert.strictEqual(auditEntries[0].context.uri.toString(), context.uri.toString());
			assert.strictEqual(auditEntries[0].result.decision, PermissionDecision.Allow);
		});

		test('should manually approve and deny with audit logging', async function () {
			const context: PermissionContext = {
				uri: URI.file('/test/manual.txt'),
				operation: PermissionOperation.Write,
				scope: PermissionScope.File,
				requestingTool: 'manual-tool',
				timestamp: new Date()
			};

			await autoPermissionService.manuallyApprove(context);

			let auditEntries = autoPermissionService.getAuditLog(1);
			assert.strictEqual(auditEntries[0].result.decision, PermissionDecision.Allow);
			assert.ok(auditEntries[0].result.reason.includes('Manually approved'));

			await autoPermissionService.manuallyDeny(context);

			auditEntries = autoPermissionService.getAuditLog(1);
			assert.strictEqual(auditEntries[0].result.decision, PermissionDecision.Deny);
			assert.ok(auditEntries[0].result.reason.includes('Manually denied'));
		});

		test('should clear audit log correctly', async function () {
			// Generate some audit entries
			for (let i = 0; i < 5; i++) {
				const context: PermissionContext = {
					uri: URI.file(`/test/file${i}.txt`),
					operation: PermissionOperation.Read,
					scope: PermissionScope.File,
					requestingTool: 'test-tool',
					timestamp: new Date()
				};
				await autoPermissionService.evaluatePermission(context);
			}

			assert.strictEqual(autoPermissionService.getAuditLog().length, 5);

			await autoPermissionService.clearAuditLog();
			assert.strictEqual(autoPermissionService.getAuditLog().length, 0);
		});

		test('should export audit log in JSON format', async function () {
			const context: PermissionContext = {
				uri: URI.file('/test/export.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'export-tool',
				timestamp: new Date()
			};

			await autoPermissionService.evaluatePermission(context);

			const jsonExport = await autoPermissionService.exportAuditLog('json');
			const parsed = JSON.parse(jsonExport);

			assert.ok(Array.isArray(parsed));
			assert.strictEqual(parsed.length, 1);
			assert.strictEqual(parsed[0].context.uri, context.uri.toString());
		});

		test('should export audit log in CSV format', async function () {
			const context: PermissionContext = {
				uri: URI.file('/test/csv-export.txt'),
				operation: PermissionOperation.Write,
				scope: PermissionScope.File,
				requestingTool: 'csv-tool',
				timestamp: new Date()
			};

			await autoPermissionService.evaluatePermission(context);

			const csvExport = await autoPermissionService.exportAuditLog('csv');
			const lines = csvExport.split('\n');

			assert.ok(lines[0].includes('Timestamp,Operation,URI,Decision')); // Header
			assert.ok(lines[1].includes('Write')); // Data row
			assert.ok(lines[1].includes('csv-export.txt'));
		});

		test('should generate statistics correctly', async function () {
			// Generate varied audit entries
			const operations = [PermissionOperation.Read, PermissionOperation.Write, PermissionOperation.Read];

			for (let i = 0; i < operations.length; i++) {
				const context: PermissionContext = {
					uri: URI.file(`/test/stats${i}.txt`),
					operation: operations[i],
					scope: PermissionScope.File,
					requestingTool: 'stats-tool',
					timestamp: new Date()
				};
				await autoPermissionService.evaluatePermission(context);
			}

			const stats = autoPermissionService.getStatistics();

			assert.strictEqual(stats.totalRequests, 3);
			assert.strictEqual(stats.operationCounts[PermissionOperation.Read], 2);
			assert.strictEqual(stats.operationCounts[PermissionOperation.Write], 1);
			assert.strictEqual(stats.decisionCounts[PermissionDecision.Allow], 3); // Default is Allow
		});

	});

	suite('Built-in Profiles', () => {

		test('should initialize built-in profiles', async function () {
			await autoPermissionService.initializeBuiltInProfiles();

			const profiles = autoPermissionService.getProfiles();
			const builtInProfiles = profiles.filter(p => p.isBuiltIn);

			assert.ok(builtInProfiles.length >= 3); // Conservative, Balanced, Permissive

			const conservativeProfile = builtInProfiles.find(p => p.securityLevel === 'conservative');
			const balancedProfile = builtInProfiles.find(p => p.securityLevel === 'balanced');
			const permissiveProfile = builtInProfiles.find(p => p.securityLevel === 'permissive');

			assert.ok(conservativeProfile, 'Should have conservative profile');
			assert.ok(balancedProfile, 'Should have balanced profile');
			assert.ok(permissiveProfile, 'Should have permissive profile');

			// Conservative should have most restrictive default
			assert.strictEqual(conservativeProfile.defaultDecision, PermissionDecision.Prompt);

			// Permissive should have least restrictive default
			assert.strictEqual(permissiveProfile.defaultDecision, PermissionDecision.Allow);
		});

		test('should set conservative profile as active by default', async function () {
			await autoPermissionService.initializeBuiltInProfiles();

			const activeProfile = autoPermissionService.getActiveProfile();
			assert.ok(activeProfile);
			assert.strictEqual(activeProfile.securityLevel, 'conservative');
		});

		test('built-in profiles should have appropriate rules', async function () {
			await autoPermissionService.initializeBuiltInProfiles();

			const profiles = autoPermissionService.getProfiles();
			const conservativeProfile = profiles.find(p => p.securityLevel === 'conservative' && p.isBuiltIn);
			const balancedProfile = profiles.find(p => p.securityLevel === 'balanced' && p.isBuiltIn);
			const permissiveProfile = profiles.find(p => p.securityLevel === 'permissive' && p.isBuiltIn);

			// Conservative should have restrictive rules
			assert.ok(conservativeProfile?.rules.some(r => r.decision === PermissionDecision.Deny));

			// Balanced should have both allow and deny rules
			assert.ok(balancedProfile?.rules.some(r => r.decision === PermissionDecision.Allow));
			assert.ok(balancedProfile?.rules.some(r => r.decision === PermissionDecision.Deny));

			// Permissive should have minimal restrictions
			const permissiveDenyRules = permissiveProfile?.rules.filter(r => r.decision === PermissionDecision.Deny) || [];
			assert.ok(permissiveDenyRules.length <= balancedProfile?.rules.filter(r => r.decision === PermissionDecision.Deny).length);
		});

	});

	suite('Error Handling and Edge Cases', () => {

		test('should handle invalid profile operations gracefully', async function () {
			try {
				await autoPermissionService.updateProfile('non-existent', { name: 'New Name' });
				assert.fail('Should throw error for non-existent profile');
			} catch (error) {
				assert.ok(error.message.includes('not found'));
			}

			try {
				await autoPermissionService.deleteProfile('non-existent');
				assert.fail('Should throw error for non-existent profile');
			} catch (error) {
				assert.ok(error.message.includes('not found'));
			}

			try {
				await autoPermissionService.setActiveProfile('non-existent');
				assert.fail('Should throw error for non-existent profile');
			} catch (error) {
				assert.ok(error.message.includes('not found'));
			}
		});

		test('should handle invalid rule operations gracefully', async function () {
			const profileId = await autoPermissionService.createProfile({
				name: 'Error Test Profile',
				description: 'For testing error conditions',
				isBuiltIn: false,
				isActive: false,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Prompt,
				securityLevel: 'custom'
			});

			try {
				await autoPermissionService.addRule('non-existent-profile', {
					name: 'Test Rule',
					description: 'Test',
					operation: PermissionOperation.Read,
					scope: PermissionScope.File,
					decision: PermissionDecision.Allow,
					riskLevel: RiskLevel.Low,
					conditions: [],
					priority: 100,
					enabled: true,
					auditRequired: false
				});
				assert.fail('Should throw error for non-existent profile');
			} catch (error) {
				assert.ok(error.message.includes('not found'));
			}

			try {
				await autoPermissionService.updateRule(profileId, 'non-existent-rule', { enabled: false });
				assert.fail('Should throw error for non-existent rule');
			} catch (error) {
				assert.ok(error.message.includes('not found'));
			}
		});

		test('should handle disabled service gracefully', async function () {
			await autoPermissionService.updateConfiguration({ enabled: false });

			const context: PermissionContext = {
				uri: URI.file('/test/disabled.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			const result = await autoPermissionService.evaluatePermission(context);
			assert.strictEqual(result.decision, PermissionDecision.Prompt);
			assert.ok(result.reason.includes('disabled'));
		});

		test('should handle missing active profile gracefully', async function () {
			// Clear all profiles (this is a bit artificial but tests the edge case)
			const profiles = autoPermissionService.getProfiles();
			for (const profile of profiles) {
				if (!profile.isBuiltIn) {
					await autoPermissionService.deleteProfile(profile.id);
				}
			}

			// Try to evaluate without active profile
			const context: PermissionContext = {
				uri: URI.file('/test/no-profile.txt'),
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				requestingTool: 'test-tool',
				timestamp: new Date()
			};

			// Should fall back to default behavior
			const result = await autoPermissionService.evaluatePermission(context);
			assert.strictEqual(result.decision, PermissionDecision.Prompt);
		});

	});

	suite('Rule Testing and Suggestions', () => {

		test('should test rules against sample contexts', async function () {
			const rule: PermissionRule = {
				id: 'test-rule',
				name: 'Test Rule',
				description: 'Rule for testing',
				operation: PermissionOperation.Read,
				scope: PermissionScope.File,
				decision: PermissionDecision.Allow,
				riskLevel: RiskLevel.Low,
				conditions: [{
					type: ConditionType.FileExtension,
					operator: 'equals',
					value: 'js'
				}],
				priority: 100,
				enabled: true,
				auditRequired: false,
				createdAt: new Date(),
				modifiedAt: new Date()
			};

			const testCases: PermissionContext[] = [
				{
					uri: URI.file('/test/script.js'),
					operation: PermissionOperation.Read,
					scope: PermissionScope.File,
					requestingTool: 'test',
					timestamp: new Date()
				},
				{
					uri: URI.file('/test/document.txt'),
					operation: PermissionOperation.Read,
					scope: PermissionScope.File,
					requestingTool: 'test',
					timestamp: new Date()
				}
			];

			const results = await autoPermissionService.testRule(rule, testCases);

			assert.strictEqual(results.length, 2);
			assert.strictEqual(results[0].matches, true); // .js file matches
			assert.strictEqual(results[1].matches, false); // .txt file doesn't match
		});

		test('should generate suggested rules based on audit history', async function () {
			// First, need an active profile to log decisions
			const profileId = await autoPermissionService.createProfile({
				name: 'Suggestion Test Profile',
				description: 'For testing rule suggestions',
				isBuiltIn: false,
				isActive: true,
				isDefault: false,
				rules: [],
				defaultDecision: PermissionDecision.Allow,
				securityLevel: 'custom'
			});
			await autoPermissionService.setActiveProfile(profileId);

			// Generate consistent pattern of decisions for .js files
			for (let i = 0; i < 6; i++) {
				const context: PermissionContext = {
					uri: URI.file(`/test/script${i}.js`),
					operation: PermissionOperation.Read,
					scope: PermissionScope.File,
					requestingTool: 'test-tool',
					timestamp: new Date()
				};
				await autoPermissionService.evaluatePermission(context); // Will be Allow due to default
			}

			const suggestions = await autoPermissionService.getSuggestedRules(30);

			// Should suggest a rule for JS files since we had consistent Allow decisions
			const jsRule = suggestions.find(rule =>
				rule.conditions.some(c =>
					c.type === ConditionType.FileExtension &&
					String(c.value) === 'js'
				)
			);

			assert.ok(jsRule, 'Should suggest rule for .js files');
			assert.strictEqual(jsRule.decision, PermissionDecision.Allow);
		});

	});

});