if (
  localStorage.getItem("thinkcrm_token") ||
  // OAuth callback — token not yet in storage, but we don't want the login
  // screen to flash while the code-exchange happens.
  /[?&]oauth_code=/.test(location.search)
) {
  document.documentElement.classList.add("has-token");
}
