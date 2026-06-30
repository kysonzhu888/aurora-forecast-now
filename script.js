const searchInput = document.querySelector("[data-city-search]");
const cityCards = [...document.querySelectorAll("[data-city-card]")];

if (searchInput && cityCards.length) {
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    for (const card of cityCards) {
      const haystack = card.dataset.search || "";
      card.classList.toggle("hidden", query.length > 0 && !haystack.includes(query));
    }
  });
}
