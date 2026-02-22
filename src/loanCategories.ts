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

function autoCategorize(content) {
  const keywords = {
    'Startup Business Loans': ['startup', 'new business', 'launch'],
    'SBA 7(a) Loans': ['sba', '7(a)', 'government'],
    'Business Line of Credit': ['line of credit', 'revolving'],
    'Short-Term Loans': ['short term', 'quick'],
    'Mid-term Loans': ['mid term', '1-3 years'],
    'Equipment Financing': ['equipment', 'machinery'],
    'Merchant Cash Advance': ['merchant', 'mca', 'credit card'],
    'Invoice Financing': ['invoice', 'receivables'],
    'Inventory Financing': ['inventory', 'stock'],
    'HELOC for Business': ['heloc', 'home equity']
  };

  for (const [category, terms] of Object.entries(keywords)) {
    for (const term of terms) {
      if (content.toLowerCase().includes(term)) {
        return category;
      }
    }
  }
  return loanCategories[0];
}

function enforceCategory(category) {
  if (!loanCategories.includes(category)) {
    throw new Error('Invalid category: ' + category);
  }
  return true;
}

export { autoCategorize, enforceCategory };