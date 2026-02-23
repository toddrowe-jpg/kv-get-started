export const loanCategories = [
    'Startup Business Loans',
    'SBA 7(a) Loans',
    'Business Line of Credit',
    'Short-Term Loans',
    'Mid-term Loans',
    'Equipment Financing',
    'Merchant Cash Advance',
    'Invoice Financing',
    'Inventory Financing',
    'HELOC for Business'
];

export function autoCategorize(amount: number): string {
    // Function logic to categorize loan based on amount
    if (amount < 50000) { return 'Short-Term Loans'; }
    else if (amount < 250000) { return 'Mid-term Loans'; }
    else return 'SBA 7(a) Loans';
}

export function enforceCategory(category: string): string {
    const categories = loanCategories;
    return categories.includes(category) ? category : 'Invalid Category';
}
