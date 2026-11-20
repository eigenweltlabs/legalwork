const sourceGrid = document.getElementById("sources");
if (navigator.language.toLowerCase().startsWith("de")) {
  document.documentElement.lang = "de";
  document.title = "Fenster aufnehmen";
  document.getElementById("title").textContent = "Fenster für die Aufnahme auswählen";
  document.getElementById("cancel").textContent = "Abbrechen";
}
const cancel = () => window.capturePicker.select(null);
document.getElementById("cancel").addEventListener("click", cancel);
document.addEventListener("keydown", event => { if (event.key === "Escape") cancel(); });
window.capturePicker.onSources(sources => {
  for (const source of sources) {
    const button = document.createElement("button");
    button.type = "button";
    const image = document.createElement("img");
    image.src = source.dataUrl;
    image.alt = "";
    const title = document.createElement("span");
    title.textContent = source.name;
    button.append(image, title);
    button.addEventListener("click", () => window.capturePicker.select(source.id));
    sourceGrid.append(button);
  }
  sourceGrid.firstElementChild?.focus();
});
