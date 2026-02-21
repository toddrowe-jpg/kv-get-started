import { SafeTokenMath } from './security';

// Structured logging functions
import { logInfo, logError } from './logging';

// Public functions
export function validateBlogId(blogId) {
    if (typeof blogId !== 'string' || blogId.trim() === '') {
        logError('Invalid blogId');
        throw new Error('Invalid blogId');
    }
    return blogId;
}

export function validateTokenCount(tokenCount) {
    const count = parseInt(tokenCount, 10);
    if (isNaN(count) || count < 0) {
        logError('Invalid token count');
        throw new Error('Invalid token count');
    }
    return count;
}

export function validateDescription(description) {
    if (typeof description !== 'string' || description.trim() === '') {
        logError('Invalid description');
        throw new Error('Invalid description');
    }
    return description;
}

export function processTokens(blogId, tokenCount, description) {
    try {
        validateBlogId(blogId);
        const count = validateTokenCount(tokenCount);
        const desc = validateDescription(description);

        // Safe arithmetic operations
        const newTokenCount = SafeTokenMath.add(count, 1);

        logInfo(`Processing tokens for ${blogId}: ${newTokenCount} tokens with description: ${desc}`);
        // Further processing logic here...
        return newTokenCount;
    } catch (error) {
        logError(`Error processing tokens: ${error.message}`);
        throw error;
    }
}