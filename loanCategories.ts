const loanCategories = ['Startup Business Loans', 'SBA 7(a) Loans', 'Business Line of Credit', 'Short-Term Loans', 'Mid-term Loans', 'Equipment Financing', 'Merchant Cash Advance', 'Invoice Financing', 'Inventory Financing', 'HELOC for Business'];

function autoCategorize(content) {
    const keywords = {
        'Startup Business Loans': ['startup', 'new business', 'entrepreneur'],
        'SBA 7(a) Loans': ['SBA', '7(a)', 'federal'],
        'Business Line of Credit': ['line of credit', 'revolving'],
        'Short-Term Loans': ['short-term', 'quick'],
        'Mid-term Loans': ['mid-term', '1-3 years'],
        'Equipment Financing': ['equipment', 'machinery'],
        'Merchant Cash Advance': ['merchant', 'cash advance', 'MCA'],
        'Invoice Financing': ['invoice', 'receivables'],
        'Inventory Financing': ['inventory', 'stock'],
        'HELOC for Business': ['HELOC', 'home equity']
    };

    for (const [category, words] of Object.entries(keywords)) {
        for (const word of words) {
            if (content.toLowerCase().includes(word)) return category;
        }
    }
    return loanCategories[0];
}

function enforceCategory(category) {
    if (!loanCategories.includes(category)) throw new Error('Invalid category: ' + category);
    return true;
}

export { loanCategories, autoCategorize, enforceCategory };