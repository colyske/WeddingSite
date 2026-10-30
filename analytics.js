/**
 * Vercel Web Analytics initialization
 * This script initializes Vercel Web Analytics for page view tracking
 */
import { inject } from './node_modules/@vercel/analytics/dist/index.mjs';

// Initialize analytics when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    inject();
  });
} else {
  inject();
}
