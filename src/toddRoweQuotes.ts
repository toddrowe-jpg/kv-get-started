const quotes: Record<string, string[]> = {
    "Home Loan": [
        "At BITX, we believe your home is more than just a place to live; it's an investment in your future.",
        "Secure your future with our tailored home loan options that reflect your personal goals."
    ],
    "Personal Loan": [
        "A personal loan can be a stepping stone to achieving your dreams. Let's make it happen together!",
        "Empower yourself with the right financial solutions that adapt to your life circumstances."
    ],
    "Business Loan": [
        "Investing in your business is investing in the community. We're here to support your entrepreneurial journey.",
        "With our business loans, we aim to empower entrepreneurs to turn their visions into reality."
    ],
    "Auto Loan": [
        "Drive your dreams with our competitive auto loan rates designed for your lifestyle.",
        "A reliable vehicle is key to achieving your goals—let us help you get there."
    ]
};

const getQuote = (category: string): string => {
    const categoryQuotes = quotes[category];
    if (categoryQuotes) {
        const randomIndex = Math.floor(Math.random() * categoryQuotes.length);
        return categoryQuotes[randomIndex];
    } else {
        return "No quotes available for this category.";
    }
};

export { getQuote };