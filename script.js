document.addEventListener("DOMContentLoaded", () => {
  // --- Countdown Logic ---
  const countdown = document.getElementById("countdown");
  const targetDate = new Date("August 15, 2026 14:00:00").getTime();
  let timer; // Define timer variable scope

  function updateCountdown() {
    const now = new Date().getTime();
    const distance = targetDate - now;

    if (distance <= 0) {
      if (countdown) countdown.textContent = "Det er vores bryllup!";
      clearInterval(timer);
      return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    if (countdown) countdown.textContent = `${days}d ${hours}t ${minutes}m ${seconds}s`;
  }

  if (countdown) {
    updateCountdown();
    timer = setInterval(updateCountdown, 1000);
  }
  const observerOptions = {
    root: null,
    threshold: 0.15, // Trigger when 15% is visible
    rootMargin: "0px 0px -50px 0px"
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        // Element is ON screen: Slide it in
        entry.target.classList.add('in-view');
      } else {
        // Element is OFF screen: Hide it again
        // This ensures it animates again next time you scroll to it
        entry.target.classList.remove('in-view');
      }
    });
  }, observerOptions);

  const animatedElements = document.querySelectorAll('.animate-from-left');
  animatedElements.forEach(el => observer.observe(el));

  // --- Navbar Scroll Logic ---
  window.addEventListener("scroll", () => {
    const nav = document.querySelector(".navbar");
    if (nav) {
      if (window.scrollY > 50) nav.classList.add("scrolled");
      else nav.classList.remove("scrolled");
    }
  });

  // --- Dynamic Text Rotation Logic ---
  const dynamicTextFull = document.getElementById("dynamic-text-full");
  const dynamicTextRef = document.getElementById("dynamic-text-ref");

  if (!dynamicTextFull || !dynamicTextRef) return; // Exit if elements are not found

  // 1. CONFIGURATION: Add the UIDs allowed to see the full list here
  // Example: const whitelist = ["uid_mormor", "uid_præst", "12345"];
  const whitelist = [
    "37KQ9EscC3gdW4kvRRKdN", // Kasper og Julie
    "9CY4R4oPbTDqZweBEuJrso", // Bente og Kresten
    "7SpaUQnUMvjDqnoLfW", // Gitte og Mads
    "32UWi3NHBLuBAKsHp89pe", // Heidi og Rasmus
    "9wWTECYJ59gyN5G2Mynh5c", // Helene og Rasmus
    "FiVWZ8k3rFKtBKEG8N3SXjaiXE", // Patrick og Nicoline
    "jC969BvGfWBq2v2AM9kbZLL", // Mikkel og Rebecca
    "i82WDMXozbpWhaqFRAEArMa", // Kristian og Rikke
    "2v1YQ9vKR5KbgL4uGi7Lg", // Ditlev og Marie
    "BJQMwkezLhwXbqRDXN8Pcx", // Simon og Katrine
    "Y2p4kN7VWQCro4KCvn4", // Thomas og Thea
    "ABqHEkDGdUrqex5xdEqvQg", // Jeppe og Camilla
    "AZKWVt9ugJigMd4zrvzhPw", // Mette og Nikolaj
    "3pc2L4fmoJ", // Joachim
    "3qL2GLen13", // Jørgen"
    "DT7eM6UY7GE", // Johannes
    "9PimJu7", // Jakob
    "2vqB3R", // Knud
    "3tt3knWMnB", // Lasse
    "43hxsayMxw", // Peter
    "3AcYebCBffh8hEr9pNMCU", // Michael og Anja
    "2yim4E", // Mads
  ];

  // 2. Get current UID from URL
  const params = new URLSearchParams(window.location.search);
  const currentUid = params.get("uid");

  // 3. Define Standard Quotes (Visible to everyone)
  const standardPairs = [
    [
      "Den, der finder en hustru, finder lykken og får en nådegave fra Herren.",
      "Ordsprogenes Bog 18:22"
    ],
    [
      "Herren var vidne mellem dig og din ungdoms hustru, som du er troløs imod, skønt hun er din ledsager og hustru ved pagt.",
      "Malakias 2:14-16"
    ],
    [
      "Jesus sagde: Har I ikke læst, at Skaberen fra begyndelsen skabte dem som mand og kvinde og sagde: ‘Derfor skal en mand forlade sin far og mor og binde sig til sin hustru, og de to skal blive ét kød’?",
      "Matthæusevangeliet 19:4-6"
    ],
    [
      "I mænd, elsk jeres hustruer, ligesom Kristus elskede kirken og gav sig selv hen for den...",
      "Efeserbrevet 5:25-28"
    ],
    [
      "Ægteskabet skal holdes i ære af alle, og ægtesengen holdes ubesmittet, for Gud vil dømme utugtige og ægteskabsbrydere.",
      "Hebræerbrevet 13:4"
    ],
    [
      "I mænd, skal ligeledes leve forstandigt med jeres hustruer som med det svagere kar og vise dem ære som medarvinger til livets nåde...",
      "1 Peter 3:7"
    ],
    [
      "Hvad Gud altså har sammenføjet, må et menneske ikke adskille.",
      "Markusevangeliet 10:9"
    ]
  ];

  // 4. Define Restricted Quotes (Visible only to whitelist)
  const restrictedPairs = [
    [
      "En kvinde, der er gift, skal underordne sig sin mand, ligesom hun underordner sig Kristus som Herre. En mand har nemlig ansvar for sin kone, ligesom Kristus har ansvar for menigheden. Menigheden er jo hans legeme, som han gav sit liv for at frelse. Ligesom menigheden underordner sig Kristus, bør kvinderne underordne sig deres mænd i alle ting.",
      "Efeserbrevet 5:22-24"
    ],
    [
      "En mand bør ikke tildække sit hoved, for han er skabt i Guds billede og til Guds ære, mens en kvinde er skabt til mandens ære. Manden blev jo ikke skabt ud fra en kvinde, men kvinden blev skabt ud fra en mand. Manden blev heller ikke skabt på grund af kvinden, men kvinden blev skabt på grund af manden.",
      "1 Korinterne 11:7-10"
    ],
    [
      "En kvinde bør underordne sig og tage imod belæring i stilhed. Jeg kan ikke tillade en kvinde at optræde som lærer. Hun bør leve i stilhed og ikke være dominerende over for en mand. Hvorfor? Fordi Adam blev skabt først og derefter Eva. Og det var ikke Adam, der blev bedraget af Satan, men kvinden, og det førte til oprør mod Guds vilje. Men kvinden vil nå frem til det evige liv ved at værne om kaldet som opdrager for sine børn og leve et fornuftigt liv i tro og kærlighed og hellighed.",
      "1 Timoteus 2:11-15"
    ],
    [
      "Så de kan opdrage de unge kvinder til at elske mand og børn, til besindighed og ærbarhed, huslighed, godhed, til at underordne sig under deres mænd, så Guds ord ikke bliver til spot.",
      "Paulus' brev til Titus 2:4-5"
    ],
    [
      "Ligeså skal I hustruer underordne jer under jeres mænd, for at de af mændene, der er ulydige mod ordet, kan blive vundet uden ord gennem deres hustruers livsførelse, når de får syn for jeres rene, gudfrygtige liv.",
      "Peters første brev 3:1-2"
    ]
  ];

  // 5. Determine which list to use
  // We create a copy of standard pairs to avoid modifying the original reference
  let pairs = [...standardPairs];

  if (currentUid && whitelist.includes(currentUid)) {
    // Add restricted pairs to the main list
    pairs = pairs.concat(restrictedPairs);
    console.log("Special content loaded for guest:", currentUid);
  }

  let index = 0;
  const textElements = [dynamicTextFull, dynamicTextRef];

  function rotatePair() {
    index = (index + 1) % pairs.length;

    // Apply transition and update text
    textElements.forEach((el) => {
      el.style.opacity = 0; // Fade out
    });

    setTimeout(() => {
      dynamicTextFull.textContent = pairs[index][0];
      dynamicTextRef.textContent = pairs[index][1];

      textElements.forEach(el => {
        el.style.opacity = 1; // Fade in
      });
    }, 1000);
  }

  // Set up transition property 
  textElements.forEach(el => el.style.transition = "opacity 1s ease");

  // Start rotation
  setInterval(rotatePair, 5000);
});