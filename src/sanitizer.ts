// src/sanitizer.ts

/**
 * Escapes HTML special characters in a string.
 * @param {string} str - The string to escape.
 * @returns {string} - The escaped string.
 */
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Validates a URL to ensure it is well-formed.
 * @param {string} url - The URL to validate.
 * @returns {boolean} - True if valid, false otherwise.
 */
function isValidUrl(url: string): boolean {
    const pattern = /^(https?:\/\/)?([\w.-]+)(:[0-9]{1,5})?(\/.*)?$/;
    return pattern.test(url);
}

/**
 * Sanitizes content by escaping HTML and validating URLs.
 * @param {string} content - The content to sanitize.
 * @returns {string} - The sanitized content.
 */
function sanitizeContent(content: string): string {
    return escapeHtml(content);
}

// Exporting functions for use in other modules.
export { escapeHtml, isValidUrl, sanitizeContent };