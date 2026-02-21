// src/tokenCounter.ts

// Function to validate user input
function validateInput(input: any): boolean {
    return typeof input === 'number' && input >= 0;
}

// Safe arithmetic function
function safeAdd(a: number, b: number): number {
    if (!validateInput(a) || !validateInput(b)) {
        throw new Error('Invalid input');
    }
    // Add numbers safely
    return a + b;
}

// Secure logging function
function secureLog(message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] - ${message}`);
}

// Example usage of safe arithmetic
try {
    const result = safeAdd(5, 10);
    secureLog(`The result is: ${result}`);
} catch (error) {
    secureLog(`Error: ${error.message}`);
}