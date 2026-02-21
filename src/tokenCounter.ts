// Sample content with security hardening

function tokenCounter(input) {
    // Input validation
    if (typeof input !== 'number' || input < 0) {
        throw new Error('Invalid input: input must be a non-negative number.');
    }

    // Safe Arithmetic Operations
    const result = Math.min(input, Number.MAX_SAFE_INTEGER);

    // Secure Logging - Here we log the processed result securely
    console.log(`Token count processed: ${result}`);
    return result;
}

module.exports = tokenCounter;