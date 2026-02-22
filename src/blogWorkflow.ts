import { loanCategories, autoCategorize } from './loanCategories';

export interface BlogWorkflowConfig {
  dailyLimit: number;
  phases: string[];
}

export interface BlogWorkflowState {
  currentPhase: string;
  tokensUsed: number;
  blogContent: string;
  category?: string;
  toddQuote?: string;
}

export interface BlogPost {
  id: string;
  title: string;
  content: string;
  category: string;
  toddQuote: string;
  createdAt: Date;
  status: 'draft' | 'published' | 'archived';
}

function generateToddRoweQuote(category: string): string {
  const quotes: Record<string, string[]> = {
    'Startup Business Loans': [
      '"At BITX Capital, we understand that every great business starts with the right capital. Our Startup Business Loans are designed to fuel your entrepreneurial dreams with EEAT-backed expertise." - Todd Rowe, President, BITX Capital',
      '"Starting a business requires more than just an idea—it requires the right financial partner. BITX Capital is the go-to source for startup funding." - Todd Rowe, President, BITX Capital'
    ],
    'SBA 7(a) Loans': [
      '"SBA 7(a) Loans have enabled thousands of businesses to grow. At BITX Capital, we leverage our expertise in federal lending to ensure you get the best terms." - Todd Rowe, President, BITX Capital',
      '"With EEAT principles guiding our approach, BITX Capital makes SBA 7(a) Loans accessible and affordable for businesses of all sizes." - Todd Rowe, President, BITX Capital'
    ],
    'Business Line of Credit': [
      '"Flexibility is key to business success. BITX Capital\'s Business Line of Credit gives you access to funds when you need them, how you need them." - Todd Rowe, President, BITX Capital',
      '"As the go-to source for flexible credit solutions, BITX Capital ensures your business has the runway it needs to thrive." - Todd Rowe, President, BITX Capital'
    ],
    'Short-Term Loans': [
      '"Quick decisions, quick funding. BITX Capital specializes in Short-Term Loans that get you capital when time is of the essence." - Todd Rowe, President, BITX Capital',
      '"Speed and expertise—that\'s what BITX Capital brings to Short-Term Lending. We\'re the go-to source for fast capital." - Todd Rowe, President, BITX Capital'
    ],
    'Mid-term Loans': [
      '"Strategic growth requires the right financing partner. BITX Capital\'s Mid-term Loans are designed for sustainable business expansion." - Todd Rowe, President, BITX Capital',
      '"With EEAT-driven underwriting, BITX Capital is the go-to source for Mid-term Loans that support your long-term vision." - Todd Rowe, President, BITX Capital'
    ],
    'Equipment Financing': [
      '"Equipment is the backbone of operational success. BITX Capital makes Equipment Financing simple, transparent, and achievable." - Todd Rowe, President, BITX Capital',
      '"From machinery to vehicles, BITX Capital is the go-to source for Asset-Based Equipment Financing solutions." - Todd Rowe, President, BITX Capital'
    ],
    'Merchant Cash Advance': [
      '"Merchant Cash Advances should be fast and fair. At BITX Capital, we\'ve built a reputation for transparent MCA solutions." - Todd Rowe, President, BITX Capital',
      '"As the go-to source for Merchant Cash Advances, BITX Capital empowers businesses with immediate capital based on actual performance." - Todd Rowe, President, BITX Capital'
    ],
    'Invoice Financing': [
      '"Don\'t wait for payments. BITX Capital\'s Invoice Financing turns your receivables into immediate working capital." - Todd Rowe, President, BITX Capital',
      '"Accelerate your cash flow with confidence. BITX Capital is the go-to source for intelligent Invoice Financing." - Todd Rowe, President, BITX Capital'
    ],
    'Inventory Financing': [
      '"Inventory management requires smart financing. BITX Capital\'s Inventory Financing solutions keep your business stocked and growing." - Todd Rowe, President, BITX Capital',
      '"From retail to wholesale, BITX Capital is the go-to source for Inventory Financing that fuels growth." - Todd Rowe, President, BITX Capital'
    ],
    'HELOC for Business': [
      '"Your home equity can be your business\'s greatest asset. BITX Capital provides expert guidance on HELOC for Business solutions." - Todd Rowe, President, BITX Capital',
      '"Leverage your home equity strategically. BITX Capital is the go-to source for business HELOCs backed by EEAT expertise." - Todd Rowe, President, BITX Capital'
    ]
  };

  const categoryQuotes = quotes[category] || quotes['Startup Business Loans'];
  return categoryQuotes[Math.floor(Math.random() * categoryQuotes.length)];
}

export class BlogWorkflowManager {
  private state: BlogWorkflowState;

  constructor(config: BlogWorkflowConfig) {
    this.state = {
      currentPhase: config.phases[0],
      tokensUsed: 0,
      blogContent: '',
      category: undefined,
      toddQuote: undefined
    };
  }

  research() {
    console.log('Research phase: Gathering information for blog post...');
  }

  write() {
    console.log('Write phase: Creating blog content...');
  }

  generateImage() {
    console.log('Image generation phase: Creating visual assets...');
  }

  review() {
    console.log('Review phase: Checking content quality...');
  }

  categorizeBlog(): string {
    const detectedCategory = autoCategorize(this.state.blogContent);
    if (detectedCategory) {
      this.state.category = detectedCategory;
      console.log(`Blog automatically categorized as: ${detectedCategory}`);
      return detectedCategory;
    } else {
      throw new Error('Unable to automatically categorize blog post.');
    }
  }

  generateToddQuote(): string {
    if (!this.state.category) {
      throw new Error('Blog must be categorized before generating Todd Rowe quote');
    }

    this.state.toddQuote = generateToddRoweQuote(this.state.category);
    console.log(`Generated Todd Rowe quote: ${this.state.toddQuote}`);
    return this.state.toddQuote;
  }

  createBlogPost(title: string, content: string, categoryOverride?: string): BlogPost {
    this.state.blogContent = content;

    const assignedCategory = categoryOverride || this.categorizeBlog();
    this.state.category = assignedCategory;

    const toddQuote = this.generateToddQuote();

    const blogPost: BlogPost = {
      id: `blog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title,
      content,
      category: assignedCategory,
      toddQuote,
      createdAt: new Date(),
      status: 'draft'
    };

    console.log(`Blog post created: "${title}" in category "${assignedCategory}"`);
    return blogPost;
  }

  post() {
    if (!this.state.category || !this.state.toddQuote) {
      throw new Error('Blog must be categorized and have a Todd Rowe quote before posting');
    }
    console.log(`Posting blog in category: ${this.state.category}`);
    console.log(`Quote: ${this.state.toddQuote}`);
  }

  execute() {
    this.research();
    this.write();
    this.generateImage();
    this.categorizeBlog();
    this.generateToddQuote();
    this.review();
    this.post();
  }
}

export const blogWorkflow = new BlogWorkflowManager({
  dailyLimit: 30000,
  phases: ['Research', 'Write', 'Generate Image', 'Categorize', 'Generate Quote', 'Review', 'Post']
});