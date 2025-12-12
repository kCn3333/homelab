// Instant highlight - nie czekaj na DOMContentLoaded
(function() {
  if (typeof hljs !== 'undefined') {
    hljs.highlightAll();
  }
  
  // Backup dla dynamic content
  document.addEventListener('DOMContentLoaded', function() {
    if (typeof hljs !== 'undefined') {
      hljs.highlightAll();
    }
  });
})();