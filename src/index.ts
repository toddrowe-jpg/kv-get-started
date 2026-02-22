export default {
  async fetch(request) {
    // Add your Cloudflare Worker fetch logic here
    // Wrap the blogWorkflow or other functionalities needed as required
    return blogWorkflow(request);
  }
};