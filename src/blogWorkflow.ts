// Import necessary modules
import { QuoteGenerator } from 'quote-generator';

// Function to generate category-specific quotes
function generateToddRoweQuote(category) {
    const quotes = {
        finance: "Efficiency, Effectiveness, and Transparency are not just principles, they're a way to do business with integrity.",
        marketing: "In today's digital landscape, being agile and responsive is what sets you apart. Embrace the change!",
        leadership: "A true leader fosters trust and collaboration, it's the core of sustained success.",
        innovation: "Innovation isn't just about technology; it's about the mindset that drives every action."
    };
    return quotes[category] || "Empowerment and accountability lead to extraordinary results.";
}

// Export the function for use in other modules
export default generateToddRoweQuote;