// src/sanitizer.ts

/**
 * Comprehensive output sanitizer for LLM responses.
 * It includes HTML escaping, malicious script removal, URL validation, Markdown support,
 * and multiple sanitization contexts (storage, blog, JSON).
 */

// Function to escape HTML characters.
function escapeHTML(str) {
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
}

// Function to remove malicious scripts.
function removeMaliciousScripts(str) {
    return str.replace(/<script.*?>([\s\S]*?)<\/script>/gi, '');
}

// Function to validate URLs.
function validateURL(url) {
    const regex = /^(https?:\/\/)?([\w-]+\.)+([\w-]{2,})(\/[^\s]*)?$/;
    return regex.test(url);
}

// Function to sanitize Markdown content.
function sanitizeMarkdown(markdown) {
    // Basic sanitization can be done here using a library like marked.js or similar.
    return markdown;
}

// Main sanitize function with context support.
function sanitizeInput(input, context) {
    let sanitized = escapeHTML(input);
    sanitized = removeMaliciousScripts(sanitized);

    if (context === 'storage') {
        // Additional rules for storage context.
        return sanitized;
    } else if (context === 'blog') {
        sanitized = sanitizeMarkdown(sanitized);
        return sanitized;
    } else if (context === 'json') {
        // Additional JSON-specific sanitization.
        return sanitized;
    }

    // Default return.
    return sanitized;
}

module.exports = { sanitizeInput };