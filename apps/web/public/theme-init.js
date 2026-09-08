(() => {
  let theme = "light";
  try {
    if (localStorage.getItem("moneykernel-theme") === "dark") theme = "dark";
  } catch {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0B0E11" : "#FFFFFF");
})();
