#!/usr/bin/env node
/**
 * A NodeJS script to intersperse multiple books for simultaneous TTS reading.
 *
 * This script takes multiple text, Markdown, or HTML files, divides them into chunks
 * of a specified word count, and combines them into a single Markdown or HTML file.
 * It inserts headers and context from previous sections to create a seamless
 * reading experience when alternating between books. HTML structure is preserved
 * to avoid breaking tags or formatting.
 *
 * Usage:
 * node varlibre.js [--queue-size N] [--chunk-size N|-c N] <outputFile.md|.html|.epub> <inputFile1.md|.html|.epub>[::startLine] [inputFile2.txt|.html|.epub]...
 *
 * Options:
 *   --queue-size N   Number of books to intersperse at once (default: 3)
 *   --chunk-size N   Number of words per chunk (default: 3000). Shorthand: -c N
 *
 * Example:
 * node varlibre.js combined_reading.md "The Hobbit.md" "Dune.txt::150"
 * node varlibre.js --queue-size 2 combined.html "Book1.html" "Book2.html"
 * node varlibre.js --chunk-size 2500 output.epub "Book1.epub" "Book2.txt"
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// --- Configuration ---
// Default number of words per chunk. This can be overridden via CLI.
const WORDS_PER_CHUNK = 3000;

/**
 * Counts the "real" words in text, ignoring HTML/Markdown syntax.
 * @param {string} text - The text to analyze.
 * @returns {number} The number of words in the text.
 */
function countWords(text) {
    if (!text) return 0;
    // Strip HTML/Markdown tags and formatting characters, then split by whitespace.
    const cleanText = text
        .replace(/<[^>]+>/g, '') // Remove HTML tags
		.replace(/[#*_`>\[\]\(\)]/g, "");    
    // Return count of non-empty strings after splitting
    return cleanText.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Detects whether a file is HTML, Markdown, or EPUB based on extension and content.
 * @param {string} filepath - The file path.
 * @param {string} content - The file content (optional, for content-based detection).
 * @returns {string} Either 'html', 'markdown', or 'epub'.
 */
function detectFileType(filepath, content = '') {
    const ext = path.extname(filepath).toLowerCase();
    if (ext === '.epub') {
        return 'epub';
    }
    if (ext === '.html' || ext === '.htm') {
        return 'html';
    }
    // If content is provided and starts with HTML-like tags, treat as HTML
    if (content.trim().startsWith('<')) {
        return 'html';
    }
    return 'markdown';
}

/**
 * Converts an EPUB file to HTML using pandoc.
 * @param {string} epubPath - Path to the EPUB file.
 * @returns {string} The HTML content.
 * @throws {Error} If pandoc is not available or conversion fails.
 */
function convertEPUBToHTML(epubPath) {
    try {
        // Check if pandoc is available
        execSync('pandoc --version', { stdio: 'ignore' });
    } catch {
        throw new Error('pandoc is not installed. Please install pandoc to process EPUB files.');
    }

    try {
        const htmlContent = execSync(`pandoc "${epubPath}" -t html`, { 
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large files
        });
        return htmlContent;
    } catch (error) {
        throw new Error(`Failed to convert EPUB to HTML: ${error.message}`);
    }
}

/**
 * Converts HTML content to EPUB using pandoc.
 * @param {string} htmlContent - The HTML content to convert.
 * @param {string} outputPath - Path where the EPUB file should be saved.
 * @throws {Error} If pandoc is not available or conversion fails.
 */
function convertHTMLToEPUB(htmlContent, outputPath) {
    // Create a temporary HTML file
    const tmpDir = os.tmpdir();
    const tmpHtmlFile = path.join(tmpDir, `varlibre-temp-${Date.now()}.html`);
    
    try {
        fs.writeFileSync(tmpHtmlFile, htmlContent, 'utf8');
        
        execSync(`pandoc "${tmpHtmlFile}" -o "${outputPath}"`, {
            stdio: 'inherit',
            maxBuffer: 10 * 1024 * 1024
        });
    } catch (error) {
        throw new Error(`Failed to convert HTML to EPUB: ${error.message}`);
    } finally {
        // Clean up temporary file
        try {
            if (fs.existsSync(tmpHtmlFile)) {
                fs.unlinkSync(tmpHtmlFile);
            }
        } catch {
            // Ignore cleanup errors
        }
    }
}

/**
 * Converts Markdown content to HTML using pandoc.
 * @param {string} markdownContent - The Markdown content to convert.
 * @returns {string} The HTML content.
 * @throws {Error} If pandoc is not available or conversion fails.
 */
function convertMarkdownToHTML(markdownContent) {
    try {
        // Check if pandoc is available
        execSync('pandoc --version', { stdio: 'ignore' });
    } catch {
        throw new Error('pandoc is not installed. Please install pandoc to process files.');
    }

    try {
        const htmlContent = execSync('pandoc -f markdown -t html', { 
            input: markdownContent,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
        return htmlContent;
    } catch (error) {
        throw new Error(`Failed to convert Markdown to HTML: ${error.message}`);
    }
}

/**
 * Converts HTML content to clean HTML using pandoc.
 * @param {string} htmlContent - The HTML content to clean.
 * @returns {string} The cleaned HTML content.
 * @throws {Error} If pandoc is not available or conversion fails.
 */
function convertHTMLToHTML(htmlContent) {
    try {
        // Check if pandoc is available
        execSync('pandoc --version', { stdio: 'ignore' });
    } catch {
        throw new Error('pandoc is not installed. Please install pandoc to process files.');
    }

    try {
        const cleanHtmlContent = execSync('pandoc -f html -t html', { 
            input: htmlContent,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
        return cleanHtmlContent;
    } catch (error) {
        throw new Error(`Failed to clean HTML: ${error.message}`);
    }
}

/**
 * Parses HTML content into block-level elements while preserving structure.
 * Extracts complete block-level elements to avoid breaking tags.
 * @param {string} content - The HTML content.
 * @returns {string[]} Array of HTML blocks.
 */
function parseHTMLContent(content) {
    // Extract block-level elements while preserving their full structure
    // Handles p, div, blockquote, article, section, li, pre, etc.
    // Also includes any non-tag text between block elements
    const blockElements = /<(p|div|blockquote|article|section|li|dd|dt|pre|table|form|fieldset)[^>]*>[\s\S]*?<\/\1>/gi;
    const blocks = [];
    let lastIndex = 0;
    let match;
    
    // Extract all complete block elements
    while ((match = blockElements.exec(content)) !== null) {
        // Add any text before this block
        if (match.index > lastIndex) {
            const textBefore = content.substring(lastIndex, match.index).trim();
            if (textBefore) blocks.push(textBefore);
        }
        blocks.push(match[0]);
        lastIndex = blockElements.lastIndex;
    }
    
    // Add any remaining text
    if (lastIndex < content.length) {
        const textAfter = content.substring(lastIndex).trim();
        if (textAfter) blocks.push(textAfter);
    }
    
    // If no blocks were found, treat the whole content as one block
    if (blocks.length === 0 && content.trim()) {
        blocks.push(content.trim());
    }
    
    return blocks;
}

/**
 * Parses Markdown content into lines.
 * @param {string} content - The Markdown content.
 * @returns {string[]} Array of lines.
 */
function parseMarkdownContent(content) {
    return content.split('\n');
}

/**
 * Creates a clean, human-readable title from a filename.
 * @param {string} filename - The full path or filename.
 * @returns {string} A sanitized string to be used as a title.
 */
function sanitizeStem(filename) {
    // Get the filename without the extension
    const stem = path.basename(filename, path.extname(filename));
    // Remove characters that aren't letters, numbers, spaces, or hyphens
    return stem.replace(/[^a-zA-Z0-9\s-]/g, '').trim();
}

/**
 * Formats a header for the output based on file type.
 * @param {string} stem - The sanitized file stem.
 * @param {string} isBeginning - Whether this is the first chunk.
 * @param {string} fileType - Either 'html' or 'markdown'.
 * @returns {string} The formatted header.
 */
function formatHeader(stem, isBeginning, fileType) {
    const headerText = isBeginning ? `Beginning ${stem}` : `Resuming ${stem} from where you left off`;
    if (fileType === 'html') {
        return `\n<h2>${headerText}</h2>\n`;
    } else {
        return `\n\n# ${headerText}\n\n`;
    }
}

/**
 * Gets context text from the end of a chunk, stripping HTML and limiting to a maximum word count.
 * @param {string[]} prevChunk - The previous chunk lines.
 * @param {number} maxWords - Maximum words to include.
 * @returns {string} The context text, plain without HTML.
 */
function getContextText(prevChunk, maxWords = 50) {
    // Join all lines and strip HTML tags
    const joinedText = prevChunk.join(' ').replace(/<[^>]+>/g, '');
    
    // Split into words and take the last maxWords words
    const words = joinedText.trim().split(/\s+/).filter(Boolean);
    
    if (words.length === 0) return '';
    
    if (words.length <= maxWords) {
        return words.join(' ');
    }
    
    // Take the last maxWords and prefix with ellipsis
    return words.slice(-maxWords).join(' ');
}

/**
 * Formats context quote for the output based on file type.
 * @param {string} contextText - The context text to quote (plain text, no HTML).
 * @param {string} fileType - Either 'html' or 'markdown'.
 * @returns {string} The formatted context.
 */
function formatContext(contextText, fileType) {
    if (!contextText || contextText.trim().length === 0) return '';
    if (fileType === 'html') {
        return `<blockquote><p>... ${contextText}</p></blockquote>\n`;
    } else {
        return `> ... ${contextText}\n\n`;
    }
}

/**
 * Parses a command-line argument for a book file.
 * Handles the optional '::lineNumber' syntax.
 * @param {string} arg - The command-line argument (e.g., "MyBook.md::200").
 * @returns {{filepath: string, startLine: number}} An object with the file path and starting line.
 */
function parseBookArg(arg) {
    const parts = arg.split('::');
    const filepath = parts[0];
    // Convert 1-based line number from argument to 0-based index for slicing
    const startLine = parts.length > 1 ? parseInt(parts[1], 10) - 1 : 0;
    
    if (isNaN(startLine) || startLine < 0) {
        console.warn(`Warning: Invalid start line for ${filepath}. Defaulting to beginning of file.`);
        return { filepath, startLine: 0 };
    }
    return { filepath, startLine };
}

/**
 * The main function to execute the script's logic.
 */
function main() {
    let queueSize = 3;
    // allow overriding the chunk-size from CLI (default is WORDS_PER_CHUNK)
    let wordsPerChunk = WORDS_PER_CHUNK;
    const args = process.argv.slice(2);
    let outputFilename;
    let bookArgs = [];

        function printHelp() {
                console.log(`Usage: node varlibre.js [--queue-size N] [--chunk-size N|-c N] [--help|-h] <outputFile.md|.html|.epub> <inputFile1.md|.html|.epub>[::startLine] [inputFile2.txt|.html|.epub]...

Options:
    --queue-size N     Number of books to intersperse at once (default: 3)
    --chunk-size N     Number of words per chunk (default: ${WORDS_PER_CHUNK}). Shorthand: -c N
    --help, -h         Show this help message

Output Format:
    The output format is determined by the output file extension:
    - .md for Markdown
    - .html for HTML
    - .epub for EPUB (converted from HTML via pandoc)
    Input files can be any supported format (.md, .html, .epub, .txt, etc.)

EPUB Support:
    EPUB files are automatically converted to HTML for processing and merged with other inputs.
    Output EPUB files are created from the final HTML via pandoc. Requires pandoc to be installed.

Examples:
    node varlibre.js -c 1500 combined.md Book1.md Book2.md
    node varlibre.js --queue-size 4 --chunk-size 2000 out.md "My Book.md::200"
    node varlibre.js combined.html book1.html book2.html
    node varlibre.js mixed_output.html "Fiction.md" "Reference.html"
    node varlibre.js output.epub "Book1.epub" "Book2.txt"
    node varlibre.js combined.html "Fiction.epub" "Reference.md"
`);
        }

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help' || args[i] === '-h') {
            printHelp();
            process.exit(0);
        }
        if (args[i] === '--queue-size' && i + 1 < args.length) {
            queueSize = parseInt(args[i + 1], 10);
            if (isNaN(queueSize) || queueSize < 1) {
                console.error('Error: Invalid queue size. Must be a positive integer.');
                process.exit(1);
            }
            i++; // skip the next arg
        } else if ((args[i] === '--chunk-size' || args[i] === '-c') && i + 1 < args.length) {
            wordsPerChunk = parseInt(args[i + 1], 10);
            if (isNaN(wordsPerChunk) || wordsPerChunk < 1) {
                console.error('Error: Invalid chunk-size. Must be a positive integer.');
                process.exit(1);
            }
            i++; // skip the next arg
        } else if (!outputFilename) {
            outputFilename = args[i];
        } else {
            bookArgs.push(args[i]);
        }
    }

    if (!outputFilename || bookArgs.length < 1) {
        console.error('Error: Insufficient arguments.');
        console.error('Usage: node varlibre.js [--queue-size N] [--chunk-size N|-c N] <outputFile.md> <inputFile1.md>[::startLine] [inputFile2.txt]...');
        process.exit(1);
    }

    const targetFormat = detectFileType(outputFilename);
    const internalFormat = targetFormat === 'epub' ? 'html' : targetFormat;

    const bookInputs = bookArgs.map(parseBookArg);
    const allBooksChunks = [];
    const successfulBooks = [];

    console.log('Starting to process books...');

    // 1. Read and chunk each book provided
    for (const book of bookInputs) {
        try {
            if (!fs.existsSync(book.filepath)) {
                throw new Error(`File not found.`);
            }
            let content = fs.readFileSync(book.filepath, 'utf8');
            let fileType = detectFileType(book.filepath, content);
            
            // Convert EPUB to HTML for processing
            if (fileType === 'epub') {
                console.log(`Converting EPUB to HTML: ${book.filepath}...`);
                content = convertEPUBToHTML(book.filepath);
                fileType = 'html';
            }
            
            // Apply start line before conversion
            if (book.startLine > 0) {
                const originalLines = content.split('\n');
                if (book.startLine >= originalLines.length) {
                     throw new Error(`Start line ${book.startLine + 1} is beyond the end of the file.`);
                }
                console.log(`Starting ${book.filepath} from line ${book.startLine + 1}.`);
                content = originalLines.slice(book.startLine).join('\n');
            }
            
            // Convert to target internal format
            if (fileType === 'html') {
                // Always convert HTML to clean it
                if (internalFormat === 'html') {
                    console.log(`Cleaning HTML for ${book.filepath}...`);
                    content = convertHTMLToHTML(content);
                } else {
                    console.log(`Converting HTML to Markdown for ${book.filepath}...`);
                    content = convertHTMLToMarkdown(content);
                }
            } else if (fileType === 'markdown' && internalFormat === 'html') {
                console.log(`Converting Markdown to HTML for ${book.filepath}...`);
                content = convertMarkdownToHTML(content);
            }

            let lines = internalFormat === 'html' ? parseHTMLContent(content) : parseMarkdownContent(content);

            const bookChunks = [];
            let currentChunkLines = [];
            let currentWordCount = 0;

            for (const line of lines) {
                currentChunkLines.push(line);
                currentWordCount += countWords(line);

                if (currentWordCount >= wordsPerChunk) {
                    bookChunks.push(currentChunkLines);
                    currentChunkLines = [];
                    currentWordCount = 0;
                }
            }

            if (currentChunkLines.length > 0) {
                bookChunks.push(currentChunkLines);
            }

            allBooksChunks.push(bookChunks);
            successfulBooks.push(book);
            console.log(`-> Processed "${book.filepath}": Found ${bookChunks.length} chunks.`);

        } catch (error) {
            console.error(`\nError processing file "${book.filepath}": ${error.message}\nSkipping this file.`);
        }
    }

    if (allBooksChunks.length === 0) {
        console.error("No valid books were processed. Exiting.");
        process.exit(1);
    }

    // 2. Set up queue and active books
    let active = [];
    let queue = [];
    for (let j = 0; j < allBooksChunks.length; j++) {
        if (active.length < queueSize) {
            active.push(j);
        } else {
            queue.push(j);
        }
    }

    const currentPos = new Array(allBooksChunks.length).fill(0);
    let finalMarkdown = '';
    let added = true;
    
    // Determine output format based on output filename
    const outputFileType = internalFormat;

    while (added) {
        added = false;
        for (let idx of active) {
            if (currentPos[idx] < allBooksChunks[idx].length) {
                const book = bookInputs[idx];
                const chunks = allBooksChunks[idx];
                const stem = sanitizeStem(book.filepath);

                // If only one book left and no others in queue, concatenate all remaining chunks
                if (active.length === 1 && queue.length === 0) {
                    // Add all remaining chunks without further chunking
                    let firstChunk = true;
                    for (let i = currentPos[idx]; i < chunks.length; i++) {
                        const currentChunk = chunks[i];
                        if (firstChunk) {
                            finalMarkdown += formatHeader(stem, currentPos[idx] === 0, outputFileType);
                            if (currentPos[idx] > 0) {
                                // Add a small context quote from the end of the previous chunk to help continuity
                                const prevChunk = chunks[currentPos[idx] - 1];
                                const contextText = getContextText(prevChunk);
                                finalMarkdown += formatContext(contextText, outputFileType);
                            }
                            firstChunk = false;
                        }
                        // Join chunk elements appropriately based on file type
                        finalMarkdown += currentChunk.join('\n');
                        finalMarkdown += '\n';
                    }
                    currentPos[idx] = chunks.length;
                } else {
                    // Normal behavior: add one chunk
                    const currentChunk = chunks[currentPos[idx]];

                    finalMarkdown += formatHeader(stem, currentPos[idx] === 0, outputFileType);

                    if (currentPos[idx] > 0) {
                        // Add a small context quote from the end of the previous chunk to help continuity
                        const prevChunk = chunks[currentPos[idx] - 1];
                        const contextText = getContextText(prevChunk);
                        finalMarkdown += formatContext(contextText, outputFileType);
                    }

                    // Join chunk elements appropriately based on file type
                    finalMarkdown += currentChunk.join('\n');
                    
                    finalMarkdown += '\n';
                    
                    currentPos[idx] += 1;
                }
                added = true;
            }
        }

        // Remove finished books from active
        active = active.filter(idx => currentPos[idx] < allBooksChunks[idx].length);

        // Add from queue
        while (active.length < queueSize && queue.length > 0) {
            active.push(queue.shift());
        }
    }

    // Wrap HTML output with proper document structure (also needed for EPUB output)
    if (outputFileType === 'html') {
        finalMarkdown = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Interspersed Books</title>
    <style>
        body { font-family: Georgia, serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
        h2 { border-top: 2px solid #333; padding-top: 20px; margin-top: 30px; }
        blockquote { font-style: italic; color: #666; padding-left: 20px; border-left: 3px solid #ddd; }
    </style>
</head>
<body>
${finalMarkdown.trim()}
</body>
</html>`;
    }

    // 3. Write the final string to the output file
    try {
        if (targetFormat === 'epub') {
            console.log('Converting HTML to EPUB via pandoc...');
            convertHTMLToEPUB(finalMarkdown.trim(), outputFilename);
        } else {
            fs.writeFileSync(outputFilename, finalMarkdown.trim());
        }
        console.log(`\n✅ Success! Interspersed book created at: ${outputFilename}`);
    } catch (error) {
        console.error(`\nFatal Error: Could not write to output file "${outputFilename}":`, error.message);
        process.exit(1);
    }
}

// Run the script
main();
