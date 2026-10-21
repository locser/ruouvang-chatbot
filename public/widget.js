(function() {
  // 1. Locate script and retrieve configurations
  const scriptTag = document.currentScript || document.querySelector('script[data-key]');
  if (!scriptTag) {
    console.error("[VPHChatbot] Loader script tag missing data-key attribute.");
    return;
  }

  const apiKey = scriptTag.getAttribute('data-key');
  const serverUrl = scriptTag.getAttribute('data-server') || window.location.origin;

  // Tên thương hiệu của shop nhúng widget — SỬA BUG-R31 (kiểm thử Red Apron
  // 05/08/2026): trợ lý xưng chung chung "Trợ lý ảo của cửa hàng", khách không
  // biết mình đang nói chuyện với ai.
  //
  // ⚠️ Không được gán cứng tên một shop vào widget: tệp này dùng chung cho MỌI
  // tenant — chính cái bẫy đã làm khách của Hasaki nhìn thấy tên "Ẩm Thực Xứ
  // Huế" (ảnh anh Sỹ gửi 06/08/2026). Tên đi từ trang nhúng vào, thiếu thì giữ
  // nguyên câu chữ trung tính như cũ.
  const tenShop = (scriptTag.getAttribute('data-ten-shop') || '').trim();

  // Ngôn ngữ: theo `<html lang>` của trang (công tắc VI/EN của storefront). Nếu trang
  // ghi `data-lang` thì dùng cố định giá trị đó. Khi khách đổi ngôn ngữ, widget được báo lại.
  const langCoDinh = scriptTag.getAttribute('data-lang');
  const chuanHoaNgonNgu = (ma) => (String(ma || '').toLowerCase().startsWith('en') ? 'en' : 'vi');
  let langHienTai = chuanHoaNgonNgu(langCoDinh || document.documentElement.lang || navigator.language);

  if (!apiKey) {
    console.error("[VPHChatbot] Missing X-Chatbot-Key.");
    return;
  }

  // 2. Inject floating button styles into host page
  const style = document.createElement('style');
  style.textContent = `
    #vph-chatbot-launcher {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background-color: #0d9488;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      transition: transform 0.2s ease, background-color 0.2s ease;
    }
    #vph-chatbot-launcher:hover {
      transform: scale(1.05);
      background-color: #0f766e;
    }
    #vph-chatbot-launcher svg {
      width: 30px;
      height: 30px;
      fill: #ffffff;
    }
    #vph-chatbot-container {
      position: fixed;
      bottom: 90px;
      right: 20px;
      width: 400px;
      height: 600px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      z-index: 999998;
      overflow: hidden;
      display: none;
      background-color: transparent;
      border: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      opacity: 0;
      transform: translateY(10px);
    }
    #vph-chatbot-container.open {
      display: block;
      opacity: 1;
      transform: translateY(0);
    }
    @media (max-width: 450px) {
      #vph-chatbot-container {
        width: calc(100% - 40px);
        height: calc(100% - 120px);
        bottom: 90px;
        right: 20px;
      }
    }
  `;
  document.head.appendChild(style);

  // 3. Create elements
  // Launcher
  const launcher = document.createElement('div');
  launcher.id = 'vph-chatbot-launcher';
  launcher.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
    </svg>
  `;
  document.body.appendChild(launcher);

  // Frame container
  const container = document.createElement('div');
  container.id = 'vph-chatbot-container';
  
  const iframe = document.createElement('iframe');
  iframe.src =
    `${serverUrl}/widget/index.html?key=${encodeURIComponent(apiKey)}` +
    (tenShop ? `&shop=${encodeURIComponent(tenShop)}` : '') +
    `&lang=${langHienTai}`;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.backgroundColor = 'transparent';
  iframe.setAttribute('allow', 'clipboard-write');
  
  container.appendChild(iframe);
  document.body.appendChild(container);

  // 4. Toggle functionality
  //
  // Mặc định ĐÓNG. CSS để `#vph-chatbot-container { display: none }` và chỉ mở
  // khi có class `.open`, nên trạng thái khởi đầu phải khớp: isOpen = false và
  // KHÔNG gắn sẵn class.
  //
  // Trước 29/07/2026 hai dòng này là `isOpen = true` + `classList.add('open')`
  // (code bật sẵn để thử rồi quên gỡ), khiến khung chat 400x600 tự bung ra che
  // trang mỗi lần khách vào web, và bấm nút bong bóng lại thành ĐÓNG.
  let isOpen = false;

  iframe.addEventListener('load', () => {
    // Chỉ báo cho ứng dụng bên trong iframe khi khung đang thực sự mở. Gửi lúc
    // đang đóng sẽ khiến nó mở phiên chat và trừ credit cho khách chưa hề bấm.
    if (isOpen) {
      iframe.contentWindow.postMessage({ type: 'vph-chat-open' }, '*');
    }
    // Iframe có thể tải xong sau khi khách đã đổi ngôn ngữ, nên báo lại ngôn ngữ hiện tại.
    iframe.contentWindow.postMessage({ type: 'vph-chat-lang', lang: langHienTai }, '*');
  });

  // Theo dõi công tắc ngôn ngữ của trang: khi `<html lang>` đổi thì báo cho khung chat.
  if (!langCoDinh) {
    new MutationObserver(() => {
      const moi = chuanHoaNgonNgu(document.documentElement.lang);
      if (moi === langHienTai) return;
      langHienTai = moi;
      iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'vph-chat-lang', lang: moi }, '*');
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  launcher.addEventListener('click', () => {
    isOpen = !isOpen;
    if (isOpen) {
      container.classList.add('open');
      iframe.contentWindow.postMessage({ type: 'vph-chat-open' }, '*');
    } else {
      container.classList.remove('open');
    }
  });

  // Listen for close requests from inside iframe
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'vph-chat-close') {
      isOpen = false;
      container.classList.remove('open');
    }
  });
})();

