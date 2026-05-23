function getToken() {
  return localStorage.getItem('token');
}

function getUser() {
  const u = localStorage.getItem('user');
  return u ? JSON.parse(u) : null;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}

function getDashboardUrl() {
  const user = getUser();
  if (!user) return 'login.html';
  return user.role === 'admin' ? 'dashboard.html' : 'user-dashboard.html';
}

function updateNavbar() {
  const user = getUser();
  const navList = document.querySelector('.navbar-nav');
  if (!navList) return;

  navList.querySelectorAll('.nav-auth-item').forEach(el => el.remove());

  if (user) {
    const dropdownLi = document.createElement('li');
    dropdownLi.className = 'nav-item dropdown nav-auth-item';

    const toggle = document.createElement('a');
    toggle.className = 'nav-link dropdown-toggle d-flex align-items-center gap-1 px-3 py-2';
    toggle.href = '#';
    toggle.role = 'button';
    toggle.dataset.bsToggle = 'dropdown';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span style="font-size:0.9rem;">👤</span> <span class="d-none d-lg-inline">' + user.name.split(' ')[0] + '</span>';

    const menu = document.createElement('ul');
    menu.className = 'dropdown-menu dropdown-menu-end bg-dark-secondary border border-secondary-custom shadow-lg';
    menu.style.minWidth = '200px';

    const header = document.createElement('li');
    header.innerHTML = '<span class="dropdown-item-text text-muted-custom font-monospace fs-7">' + user.email + '</span>';
    menu.appendChild(header);

    const divider1 = document.createElement('li');
    divider1.innerHTML = '<hr class="dropdown-divider border-secondary-custom">';
    menu.appendChild(divider1);

    if (user.role === 'admin') {
      const dashLink = createDropdownItem('📊', ' Dashboard', 'dashboard.html');
      menu.appendChild(dashLink);
      const projectsLink = createDropdownItem('📂', ' Proyectos', 'admin.html');
      menu.appendChild(projectsLink);
    } else {
      const dashLink = createDropdownItem('📊', ' Mi Panel', 'user-dashboard.html');
      menu.appendChild(dashLink);
    }

    const settingsLink = createDropdownItem('⚙️', ' Ajustes', 'account-settings.html');
    menu.appendChild(settingsLink);

    const divider2 = document.createElement('li');
    divider2.innerHTML = '<hr class="dropdown-divider border-secondary-custom">';
    menu.appendChild(divider2);

    const logoutItem = document.createElement('li');
    const logoutBtn = document.createElement('a');
    logoutBtn.className = 'dropdown-item text-danger';
    logoutBtn.href = '#';
    logoutBtn.innerHTML = '🚪 Cerrar sesión';
    logoutBtn.addEventListener('click', function (e) {
      e.preventDefault();
      logout();
    });
    logoutItem.appendChild(logoutBtn);
    menu.appendChild(logoutItem);

    dropdownLi.appendChild(toggle);
    dropdownLi.appendChild(menu);
    navList.appendChild(dropdownLi);

  } else {
    const li = document.createElement('li');
    li.className = 'nav-item mt-3 mt-lg-0 nav-auth-item';
    const a = document.createElement('a');
    a.className = 'btn btn-outline-accent w-100 w-lg-auto ms-lg-3 px-4';
    a.href = 'login.html';
    a.textContent = 'Mi cuenta';
    li.appendChild(a);
    navList.appendChild(li);
  }
}

function createDropdownItem(icon, text, href) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'dropdown-item';
  a.href = href;
  a.innerHTML = icon + ' ' + text;
  li.appendChild(a);
  return li;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateNavbar);
} else {
  updateNavbar();
}
