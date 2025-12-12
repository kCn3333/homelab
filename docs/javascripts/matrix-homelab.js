// File: docs/javascripts/matrix-homelab.js
// Matrix falling letters effect for HOMELAB title

(function() {
    // Wait for page load
    document.addEventListener('DOMContentLoaded', function() {
        // Find the first H1 that contains "Homelab" or similar
        const h1Elements = document.querySelectorAll('.md-typeset h1');
        let targetH1 = null;
        
        h1Elements.forEach(h1 => {
            if (h1.textContent.toLowerCase().includes('homelab')) {
                targetH1 = h1;
            }
        });
        
        if (!targetH1) return;
        
        // Store original text
        const originalText = targetH1.textContent.trim();
        
        // Clear and setup container
        targetH1.innerHTML = '';
        targetH1.style.position = 'relative';
        targetH1.style.minHeight = '4rem';
        targetH1.style.display = 'block';
        
        // Create container for animation
        const container = document.createElement('div');
        container.style.position = 'relative';
        container.style.width = '100%';
        container.style.height = '4rem';
        targetH1.appendChild(container);
        
        // Create final text element (hidden initially)
        const finalText = document.createElement('span');
        finalText.textContent = originalText;
        finalText.style.opacity = '0';
        finalText.style.display = 'inline-block';
        finalText.style.transition = 'opacity 1s';
        container.appendChild(finalText);
        
        const word = originalText.toUpperCase();
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()";
        
        function startAnimation() {
            // Clear previous animation
            container.querySelectorAll('.letter-column').forEach(col => col.remove());
            finalText.style.opacity = '0';
            
            const containerWidth = container.offsetWidth;
            const letterSpacing = Math.min(60, containerWidth / (word.length + 1));
            const startX = (containerWidth - (letterSpacing * word.length)) / 2;
            
            // Create columns for each letter
            word.split('').forEach((targetLetter, index) => {
                const column = document.createElement('div');
                column.className = 'letter-column';
                column.style.position = 'absolute';
                column.style.top = '-100px';
                column.style.left = `${startX + letterSpacing * index}px`;
                column.style.fontSize = '1.2rem';
                column.style.color = '#00FF41';
                column.style.textShadow = '0 0 5px #00FF41';
                column.style.zIndex = '1';
                container.appendChild(column);
                
                // Start falling animation
                startFallingColumn(column, targetLetter, index * 150);
            });
            
            // Show final text after animation
            setTimeout(() => {
                container.querySelectorAll('.letter-column').forEach(col => {
                    col.style.transition = 'opacity 0.5s';
                    col.style.opacity = '0';
                });
                
                setTimeout(() => {
                    finalText.style.opacity = '1';
                    container.querySelectorAll('.letter-column').forEach(col => col.remove());
                }, 500);
            }, word.length * 150 + 2000);
        }
        
        function startFallingColumn(column, targetLetter, delay) {
            setTimeout(() => {
                let position = -100;
                let iterations = 0;
                const maxIterations = 12;
                
                const interval = setInterval(() => {
                    iterations++;
                    
                    // Add random falling characters
                    if (iterations < maxIterations - 2) {
                        const randomChar = chars[Math.floor(Math.random() * chars.length)];
                        const letter = document.createElement('div');
                        letter.textContent = randomChar;
                        letter.style.textAlign = 'center';
                        letter.style.lineHeight = '1.5';
                        letter.style.opacity = '0.7';
                        column.insertBefore(letter, column.firstChild);
                        
                        // Limit number of letters
                        if (column.children.length > 8) {
                            column.lastChild.remove();
                        }
                    }
                    
                    // Move down
                    position += 12;
                    column.style.top = `${position}px`;
                    
                    // Fade older letters
                    Array.from(column.children).forEach((letter, i) => {
                        letter.style.opacity = Math.max(0, 0.7 - i * 0.1);
                    });
                    
                    // Stop and show target letter
                    if (iterations >= maxIterations) {
                        clearInterval(interval);
                        
                        column.innerHTML = '';
                        const finalLetter = document.createElement('div');
                        finalLetter.textContent = targetLetter;
                        finalLetter.style.fontSize = '1.5rem';
                        finalLetter.style.color = '#33FF66';
                        finalLetter.style.textShadow = '0 0 15px #00FF41';
                        finalLetter.style.textAlign = 'center';
                        finalLetter.style.animation = 'letterPulse 0.5s';
                        column.appendChild(finalLetter);
                        
                        column.style.top = '50%';
                        column.style.transform = 'translateY(-50%)';
                    }
                }, 60);
            }, delay);
        }
        
        // Add animation keyframes
        if (!document.getElementById('matrix-homelab-styles')) {
            const style = document.createElement('style');
            style.id = 'matrix-homelab-styles';
            style.textContent = `
                @keyframes letterPulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.4); }
                }
            `;
            document.head.appendChild(style);
        }
        
        // Start animation after a short delay
        setTimeout(startAnimation, 300);
        
        // Optional: Restart on click (for fun)
        targetH1.style.cursor = 'pointer';
        targetH1.addEventListener('click', startAnimation);
    });
})();