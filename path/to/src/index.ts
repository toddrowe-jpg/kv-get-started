import { blogWorkflow } from './workflows/blog';
import middleware from './middleware';
import security from './security';

export default { 
  async fetch(request: Request): Promise<Response> {
    try {
      // Set security headers
      const securityHeaders = security.getHeaders();
      
      // Apply middleware
      const modifiedRequest = middleware.apply(request);
      
      // Handle the request using the blog workflow
      const response = await blogWorkflow(modifiedRequest);
      
      // Return the response with security headers
      return new Response(response.body, {
        ...response,
        headers: { ...response.headers, ...securityHeaders }
      });
    } catch (error) {
      console.error('Error handling request:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }
};
