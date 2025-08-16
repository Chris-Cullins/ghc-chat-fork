# Drag and Drop Test Guide

## Testing the Enhanced Drag and Drop Functionality

### Test Cases

#### 1. VS Code Explorer Drag and Drop
- **Action**: Drag files from VS Code Explorer to the queue webview
- **Expected**: Files should be added to queue with proper visual feedback
- **Data Format**: `text/uri-list` with `file://` URIs

#### 2. External File Manager Drag and Drop
- **Action**: Drag files from external file manager (Finder/Explorer) to the queue
- **Expected**: Files should be added with fallback to file names
- **Data Format**: `dataTransfer.files`

#### 3. Multiple File Drop
- **Action**: Select and drag multiple files at once
- **Expected**: All files added using batch operation with single success message

#### 4. Invalid File Drop
- **Action**: Try to drop unsupported content
- **Expected**: Error message displayed, no files added

#### 5. Visual Feedback
- **Actions**: 
  - Start dragging files over the webview
  - Drag over different zones (queue list, empty state)
  - Drag leave the webview
- **Expected**: 
  - Dashed border appears on drag enter
  - "Drop files here" message shows
  - Visual state clears on drag leave
  - Global drag state management

### Implementation Features

#### JavaScript Enhancements
- ✅ Enhanced drag event handlers (`handleDragEnter`, `handleDragOver`, `handleDrop`, `handleDragLeave`)
- ✅ Support for VS Code internal drag data (`text/uri-list`, `application/vnd.code.tree.explorer`)
- ✅ Support for external file drops (`dataTransfer.files`)
- ✅ Text drag support for file paths
- ✅ Batch file processing with `addMultipleFiles` message
- ✅ Error handling and validation
- ✅ Visual feedback management

#### CSS Enhancements
- ✅ Enhanced `.drag-over` styling with dashed borders
- ✅ Global drag state with `body.drag-active`
- ✅ Drop zone highlighting
- ✅ Animated feedback for drag operations
- ✅ "Drop files here" overlay message

#### TypeScript Enhancements
- ✅ New `AddMultipleFilesMessage` interface
- ✅ Enhanced error handling with file validation
- ✅ Batch processing support
- ✅ Better user feedback with info messages

### Data Formats Handled

1. **VS Code URI List**: `text/uri-list` with `file://` URIs
2. **VS Code Explorer**: `application/vnd.code.tree.explorer` JSON data
3. **External Files**: `dataTransfer.files` File objects
4. **Text Paths**: `text/plain` with file path strings

### Error Handling

- Invalid file paths are filtered out
- File validation through the queue service
- Appropriate error messages for different failure scenarios
- Graceful fallback for unsupported drop types