import { sanitize } from './sanitizer';

// Example functions in src/index.ts

const processLLMOutputs = (output) => {
    return sanitize(output);
};

const saveToKVStorage = (data) => {
    const sanitizedData = sanitize(data);
    // Save sanitizedData to KV storage
};

const insertBlogContent = (content) => {
    const safeContent = sanitize(content);
    // Insert safeContent to blog
};

const handleJsonResponse = (response) => {
    const safeResponse = sanitize(response);
    // Send safeResponse as JSON response
};
