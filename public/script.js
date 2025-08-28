// const $ = (s) => document.querySelector(s);
// const $$ = (s) => document.querySelectorAll(s);

// // Show loader
// function showLoader() {
//   $("#loader").style.display = "flex";
//   $("#fetch").disabled = true;
// }

// // Hide loader
// function hideLoader() {
//   $("#loader").style.display = "none";
//   $("#fetch").disabled = false;
// }

// $("#fetch").addEventListener("click", async () => {
//   const url = $("#url").value.trim();
//   $("#error").textContent = "";
//   $("#meta").style.display = "none";
//   if (!url) {
//     $("#error").textContent = "Please paste a valid YouTube URL";
//     return;
//   }
  
//   try {
//     showLoader();
//     const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
//     if (!res.ok) {
//       const data = await res.json();
//       throw new Error(data?.error || "Failed to fetch video info");
//     }
//     const data = await res.json();
    
//     $("#meta").style.display = "block";
//     $("#title").textContent = data.title;
//     const thumb = (data.thumbnails || []).slice(-1)[0]?.url || "";
//     $("#thumb").src = thumb;
//     const tbody = $("#formats tbody");
//     tbody.innerHTML = "";

//     (data.formats || []).forEach(f => {
//       const tr = document.createElement("tr");
//       const qualityText = f.qualityLabel;
//       tr.innerHTML = `<td>${qualityText}</td>
//         <td><button>Download</button></td>`;
//       tr.querySelector("button").addEventListener("click", () => {
//         // Trigger download directly
//         const link = document.createElement('a');
//         link.href = `/api/download?url=${encodeURIComponent(data.url)}&itag=${f.itag}`;
//         link.download = ''; // Empty string to use server's filename
//         document.body.appendChild(link);
//         link.click();
//         document.body.removeChild(link);
//       });
//       tbody.appendChild(tr);
//     });

//     $("#download-best").onclick = () => {
//       // Trigger download for best quality
//       const link = document.createElement('a');
//       link.href = `/api/download?url=${encodeURIComponent(data.url)}`;
//       link.download = ''; // Empty string to use server's filename
//       document.body.appendChild(link);
//       link.click();
//       document.body.removeChild(link);
//     };
//   } catch (e) {
//     $("#error").textContent = `Error: ${e.message}. Please check the URL and try again.`;
//   } finally {
//     hideLoader();
//   }
// });

// // Add event listener for Enter key in input field
// $("#url").addEventListener("keypress", (e) => {
//   if (e.key === "Enter") {
//     $("#fetch").click();
//   }
// });