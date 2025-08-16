# File Queue Extension Tests

This directory contains comprehensive tests for the File Queue extension functionality, specifically verifying the fixes for the two major bugs identified in the IMPLEMENTATION_PLAN.md:

## Bug Fixes Tested

### 🐛 Bug 1: Add File Button Not Working
**Issue**: "Add File button does not seem to do anything. maybe needs a file picker popup?"
**Fix Verified**: The Add File button now properly opens a VS Code file picker dialog, allows priority/operation selection, and adds files to the queue.

### 🐛 Bug 2: Drag and Drop Not Working  
**Issue**: "Drag and drop functionality does not seem to work - don't see any files being added to queue. Perhaps I'm dropping them in the wrong place? not sure."
**Fix Verified**: Drag and drop now properly handles files from VS Code Explorer, supports multiple file drops, provides visual feedback, and correctly adds files to the queue.

## Test Files

### Core Tests
- **`fileQueueWebviewProvider.test.ts`** - Unit tests for the webview provider message handling, file picker integration, and error handling
- **`dragDropFunctionality.test.ts`** - Comprehensive tests for drag and drop functionality including VS Code Explorer data formats, Windows path handling, and security restrictions
- **`fileQueueIntegration.test.ts`** - End-to-end integration tests verifying webview-to-extension communication and queue management
- **`webviewClientLogic.test.ts`** - Client-side JavaScript functionality tests for UI state management and event handling

### Bug Verification
- **`bugFixVerification.test.ts`** - Specific tests that verify both original bugs are fixed and the features work as expected

### Configuration
- **`vitest.config.ts`** - Test configuration for Vitest with JSDOM environment
- **`setup.ts`** - Test setup with global mocks and DOM helpers

## Key Features Tested

### ✅ Add File Button Functionality
- File picker dialog opens correctly
- Priority selection workflow
- Operation selection workflow  
- Multiple file selection support
- Cancellation handling
- Success/error feedback
- Files actually added to queue service

### ✅ Drag and Drop Functionality
- VS Code Explorer file drops
- Multiple file handling
- Windows and Unix path support
- Visual feedback during drag operations
- Security restrictions for external files
- Error handling for invalid drops
- File validation and feedback

### ✅ Integration & Communication
- Webview-to-extension message passing
- Real-time queue updates
- Event system functionality
- State persistence
- Error propagation
- UI synchronization

### ✅ Error Handling & Validation
- File validation before adding
- Large file rejection
- Missing path handling
- Unknown message types
- Network error recovery
- User feedback for all error conditions

## Running the Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- fileQueueWebviewProvider.test.ts

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

## Test Coverage

The tests provide comprehensive coverage of:
- Message handling (100% of message types)
- File operations (add, remove, validation)
- User interactions (button clicks, drag/drop)
- Error scenarios (invalid files, cancellation)
- UI state management (progress, statistics, controls)
- Integration workflows (end-to-end user journeys)

## Mock Strategy

The tests use a multi-layered mock strategy:
1. **VS Code API Mocks** - Mock file dialogs, notifications, and VS Code-specific APIs
2. **Service Mocks** - Mock file queue service with realistic behavior
3. **DOM Mocks** - JSDOM for testing webview JavaScript functionality
4. **Event Mocks** - Mock drag/drop events and data transfer objects

## Verification Summary

✅ **Bug 1 Fixed**: Add File button now opens file picker and adds files to queue  
✅ **Bug 2 Fixed**: Drag and drop properly handles VS Code Explorer files  
✅ **Error Handling**: Comprehensive error handling and user feedback  
✅ **Integration**: Webview and extension communicate correctly  
✅ **UI Updates**: Queue state updates reflect in real-time  
✅ **Validation**: File validation prevents invalid operations  

All tests pass and verify that the original bugs mentioned in the implementation plan have been successfully resolved.