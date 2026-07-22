const domainElement = document.querySelector("#domain");

function storedDomain() {
  try {
    return JSON.parse(
      localStorage.getItem("fuck-ddl:active-distraction-domain") ?? "null",
    );
  } catch {
    return null;
  }
}

window.setDistractionDomain = (domain) => {
  const normalized = String(domain ?? "")
    .trim()
    .toLowerCase();
  if (normalized) domainElement.textContent = normalized;
};

window.setDistractionDomain(storedDomain());
window.addEventListener("storage", (event) => {
  if (event.key === "fuck-ddl:active-distraction-domain") {
    window.setDistractionDomain(storedDomain());
  }
});
