import express from 'express';
import AuthenticationMiddleware from './middlewares/AuthenticationMiddleware';
import RateLimiter from './middlewares/RateLimiter';
import InputValidator from './middlewares/InputValidator';
import SecurityErrorHandler from './middlewares/SecurityErrorHandler';

const app = express();

// Use middlewares
app.use(AuthenticationMiddleware);
app.use(RateLimiter);
app.use(InputValidator);

// Example route setup
app.get('/example', (req, res) => {
    // Handle request
});

// Error handling middleware
app.use(SecurityErrorHandler);
