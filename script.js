document.addEventListener("DOMContentLoaded", () => {
    // --- Countdown Logic ---
    const countdown = document.getElementById("countdown");
    const targetDate = new Date("August 15, 2026 14:00:00").getTime();

    function updateCountdown() {
        const now = new Date().getTime();
        const distance = targetDate - now;

        if (distance <= 0) {
            countdown.textContent = "Det er vores bryllup!";
            clearInterval(timer);
            return;
        }

        const days = Math.floor(distance / (1000 * 60 * 60 * 24));
        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);

        countdown.textContent = `${days}d ${hours}t ${minutes}m ${seconds}s`;
    }

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);

    // --- Navbar Scroll Logic ---
    window.addEventListener("scroll", () => {
        const nav = document.querySelector(".navbar");
        if (window.scrollY > 50) nav.classList.add("scrolled");
        else nav.classList.remove("scrolled");
    });

    // --- Dynamic Text Rotation Logic ---
    const dynamicTextFull = document.getElementById("dynamic-text-full");
    const dynamicTextRef = document.getElementById("dynamic-text-ref");

    if (!dynamicTextFull || !dynamicTextRef) return; // Exit if elements are not found

    const textElements = [dynamicTextFull, dynamicTextRef];

    const pairs = [
        [
            // Default initial content
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
        //],  
        //[
        //    "En kvinde, der er gift, skal underordne sig sin mand, ligesom hun underordner sig Kristus som Herre. En mand har nemlig ansvar for sin kone, ligesom Kristus har ansvar for menigheden. Menigheden er jo hans legeme, som han gav sit liv for at frelse. Ligesom menigheden underordner sig Kristus, bør kvinderne underordne sig deres mænd i alle ting.", 
        //    "Efeserbrevet 5:22-24"
        //],
        //[
        //    "En mand bør ikke tildække sit hoved, for han er skabt i Guds billede og til Guds ære, mens en kvinde er skabt til mandens ære. Manden blev jo ikke skabt ud fra en kvinde, men kvinden blev skabt ud fra en mand. Manden blev heller ikke skabt på grund af kvinden, men kvinden blev skabt på grund af manden.",
        //    "1 Korinterne 11:7-10"
        //],
        //[
        //    "En kvinde bør underordne sig og tage imod belæring i stilhed. Jeg kan ikke tillade en kvinde at optræde som lærer. Hun bør leve i stilhed og ikke være dominerende over for en mand. Hvorfor? Fordi Adam blev skabt først og derefter Eva. Og det var ikke Adam, der blev bedraget af Satan, men kvinden, og det førte til oprør mod Guds vilje. Men kvinden vil nå frem til det evige liv ved at værne om kaldet som opdrager for sine børn og leve et fornuftigt liv i tro og kærlighed og hellighed.",
        //    "1 Timoteus 2:11-15"
        ]
    ];

    let index = 0; // Start at index 0, which holds the current initial content

    function rotatePair() {
        // Move to the next index, wrapping around to the start of the array
        index = (index + 1) % pairs.length;

        // Apply transition and update text
        textElements.forEach((el, i) => {
            el.style.opacity = 0; // Fade out
        });
        
        setTimeout(() => {
            dynamicTextFull.textContent = pairs[index][0]; // Update the main text
            dynamicTextRef.textContent = pairs[index][1];   // Update the reference text
            
            textElements.forEach(el => {
                el.style.opacity = 1; // Fade in
            });
        }, 500); // Wait for fade-out before changing content
    }

    // Set up transition property (assuming basic CSS for opacity transition exists)
    textElements.forEach(el => el.style.transition = "opacity 0.5s ease");

    // Start rotation immediately after initial content is shown, then repeat every 5 seconds
    const rotationInterval = setInterval(rotatePair, 8000);

    // Initial check: if the first pair is not the "meet cute" story, start rotation immediately 
    // from the first Bible verse pair.
    if (dynamicTextFull.textContent.includes("Den, der finder")) {
        // The first rotation will pull from index 1 (the first verse) 5 seconds from now
        // so we start the index at 0, which is the "meet cute" story.
    } else {
        index = 0;
    }

    // --- RSVP Accept/Decline Logic ---
    const acceptBtn = document.querySelector(".accept");
    const declineBtn = document.querySelector(".decline");

    if (acceptBtn && declineBtn) {
        acceptBtn.addEventListener("click", () => {
            alert("Tak for dit svar! Vi glæder os til at se dig 💐");
        });

        declineBtn.addEventListener("click", () => {
            alert("Tak for dit svar! Vi er kede af, at du ikke kan komme 💌");
        });
    }
});



const images = document.querySelectorAll(".image-grid img");
const modal = document.getElementById("imageModal");
const modalImg = document.getElementById("modalImage");
const closeBtn = document.querySelector(".close");
const nextBtn = document.querySelector(".next");
const prevBtn = document.querySelector(".prev");

let currentIndex = 0;

// Open modal when clicking an image
images.forEach((img, index) => {
  img.addEventListener("click", () => {
    currentIndex = index;
    openModal();
  });
});

function openModal() {
  modal.style.display = "block";
  modalImg.src = images[currentIndex].src;
  document.body.style.overflow = "hidden"; // prevent scrolling
}

// Close modal
closeBtn.onclick = () => {
  modal.style.display = "none";
  document.body.style.overflow = "auto";
};

// Navigate images
nextBtn.onclick = () => {
  currentIndex = (currentIndex + 1) % images.length;
  modalImg.src = images[currentIndex].src;
};

prevBtn.onclick = () => {
  currentIndex = (currentIndex - 1 + images.length) % images.length;
  modalImg.src = images[currentIndex].src;
};

// Close modal when clicking outside image
modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    modal.style.display = "none";
    document.body.style.overflow = "auto";
  }
});

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  if (modal.style.display === "block") {
    if (e.key === "ArrowRight") nextBtn.click();
    if (e.key === "ArrowLeft") prevBtn.click();
    if (e.key === "Escape") closeBtn.click();
  }
});


// --- Image Upload Logic ---
const uploadInput = document.getElementById("uploadInput");
const imageGrid = document.querySelector(".image-grid");

uploadInput.addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  files.forEach((file) => {
    if (!file.type.startsWith("image/")) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const newImg = document.createElement("img");
      newImg.src = e.target.result;
      newImg.alt = file.name;
      newImg.addEventListener("click", () => {
        currentIndex = Array.from(imageGrid.children).indexOf(newImg);
        openModal();
      });
      imageGrid.appendChild(newImg);
    };
    reader.readAsDataURL(file);
  });

  // Reset input to allow re-uploading same files
  event.target.value = "";
});


