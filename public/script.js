async function fetchVideoInfo() {
  const urlInput = document.getElementById("url-input").value;
  const infoDiv = document.getElementById("video-info");
  const formatsTable = document.getElementById("formats-table").getElementsByTagName("tbody")[0];
  const errorDiv = document.getElementById("error");
  const countdownDiv = document.getElementById("countdown");

  infoDiv.innerHTML = "";
  formatsTable.innerHTML = "";
  errorDiv.textContent = "";
  countdownDiv.textContent = "";

  try {
    const response = await fetch(`/api/info?url=${encodeURIComponent(urlInput)}`);
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Server se response nahi mila.");
    }
    const data = await response.json();

    // Display video info
    infoDiv.innerHTML = `
      <h2>${data.title}</h2>
      <p><strong>Uploader:</strong> ${data.author}</p>
      <p><strong>Duration:</strong> ${Math.floor(data.lengthSeconds / 60)}:${(data.lengthSeconds % 60).toString().padStart(2, "0")}</p>
      <img src="${data.thumbnails[0]?.url}" alt="Thumbnail" style="max-width: 200px;">
    `;

    // Populate formats table
    data.formats.forEach((format) => {
      const row = formatsTable.insertRow();
      row.innerHTML = `
        <td>${format.qualityLabel}</td>
        <td>${format.container}</td>
        <td>${format.hasVideo ? "Yes" : "No"}</td>
        <td>${format.hasAudio ? "Yes" : "No"}</td>
        <td>${format.filesize ? (format.filesize / 1024 / 1024).toFixed(2) + " MB" : "Unknown"}</td>
        <td><button onclick="startDownloadCountdown('${format.itag}')">Download</button></td>
      `;
    });
  } catch (err) {
    errorDiv.textContent = err.message || "Video info fetch karne mein error aaya. URL check karein aur dobara try karein.";
  }
}

function startDownloadCountdown(itag) {
  let seconds = 10;
  const countdownDiv = document.getElementById("countdown");
  countdownDiv.textContent = `Download starting in ${seconds} seconds...`;

  const interval = setInterval(() => {
    seconds--;
    countdownDiv.textContent = `Download starting in ${seconds} seconds...`;
    if (seconds <= 0) {
      clearInterval(interval);
      const urlInput = document.getElementById("url-input").value;
      window.location.href = `/api/download?url=${encodeURIComponent(urlInput)}&itag=${itag}`;
    }
  }, 1000);
}