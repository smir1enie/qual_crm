// ===== Login page interactions =====

// Toggle password visibility
const togglePassword = document.getElementById('togglePassword');
const passwordInput = document.getElementById('password');

if (togglePassword && passwordInput) {
  togglePassword.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    togglePassword.setAttribute('aria-label', isPassword ? 'Скрыть пароль' : 'Показать пароль');
  });
}

// Form submit -> go to dashboard
const loginForm = document.getElementById('loginForm');
if (loginForm) {
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    window.location.href = 'dashboard.html';
  });
}
