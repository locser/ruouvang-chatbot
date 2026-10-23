(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const apiKey = urlParams.get('key');

  // Tên shop do trang nhúng truyền vào qua `data-ten-shop` (xem public/widget.js).
  // SỬA BUG-R31: trợ lý xưng đúng tên thương hiệu thay vì "cửa hàng" chung chung.
  // Thiếu tham số thì giữ nguyên câu chữ trung tính — widget dùng chung nhiều
  // tenant, không được gán cứng tên bất kỳ shop nào.
  const tenShop = (urlParams.get('shop') || '').trim();

  // Ngôn ngữ giao diện: trang nhúng truyền `lang` (vi | en) và loader báo lại khi khách đổi ngôn ngữ trên trang.
  const CHUOI = {
    vi: {
      tieuDeMacDinh: 'Trợ lý Cửa hàng',
      tieuDeShop: (ten) => `Trợ lý ${ten}`,
      xungHoMacDinh: 'cửa hàng',
      chao: (xungHo) => `Dạ em chào anh/chị ạ! Trợ lý ảo của ${xungHo} xin phép được hỗ trợ. Anh/chị cần tư vấn thông tin gì ạ?`,
      gopY: 'Cần đổi địa chỉ, huỷ đơn hay hỏi thêm? Nhắn kèm mã đơn để chúng tôi xử lý nhanh nhất.',
      placeholder: 'Nhập câu hỏi của bạn...',
      trangThaiBot: 'Trợ lý ảo tự động',
      trangThaiNguoi: 'Nhân viên trực tuyến',
      trangThaiChuyen: 'Đang chuyển giao nhân viên...',
      nhanNhanVien: 'Nhân viên:',
      nhanVienThamGia: 'Nhân viên tư vấn đã tham gia hội thoại.',
      loiKetNoi: 'Không thể kết nối đến máy chủ. Vui lòng tải lại trang.',
      guiThatBai: 'Gửi tin thất bại.',
      loiTruyenTin: 'Có lỗi xảy ra khi truyền tin. Vui lòng thử lại.',
      xacNhanXoa: 'Toàn bộ tin nhắn trong cuộc trò chuyện này sẽ bị xoá và không thể khôi phục.',
      ghiChuXoa: 'Đơn hàng bạn đã đặt vẫn được giữ nguyên.',
      huyXoa: 'Giữ lại',
      nutXoa: 'Xoá cuộc trò chuyện',
      dangXoa: 'Đang xoá...',
      daXoa: 'Đã xoá lịch sử trò chuyện.',
      xoaThatBai: 'Không xoá được lịch sử, vui lòng thử lại.',
      tieuDeXoa: 'Xoá lịch sử trò chuyện',
      tieuDeDong: 'Đóng cửa sổ trò chuyện',
    },
    en: {
      tieuDeMacDinh: 'Store Assistant',
      tieuDeShop: (ten) => `${ten} Assistant`,
      xungHoMacDinh: 'our store',
      chao: (xungHo) => `Hello, welcome! This is the virtual assistant of ${xungHo}. How can I help you today?`,
      gopY: 'Need to change your address, cancel an order, or have a question? Send us your order code so we can help you fastest.',
      placeholder: 'Type your question...',
      trangThaiBot: 'Automated virtual assistant',
      trangThaiNguoi: 'Staff online',
      trangThaiChuyen: 'Transferring to our staff...',
      nhanNhanVien: 'Staff:',
      nhanVienThamGia: 'A staff member has joined the conversation.',
      loiKetNoi: 'Unable to connect to the server. Please reload the page.',
      guiThatBai: 'Failed to send message.',
      loiTruyenTin: 'Something went wrong while sending your message. Please try again.',
      xacNhanXoa: 'All messages in this conversation will be deleted and cannot be recovered.',
      ghiChuXoa: 'Orders you have placed will be kept.',
      huyXoa: 'Keep chat',
      nutXoa: 'Delete conversation',
      dangXoa: 'Deleting...',
      daXoa: 'Chat history deleted.',
      xoaThatBai: 'Could not delete the history, please try again.',
      tieuDeXoa: 'Delete chat history',
      tieuDeDong: 'Close chat window',
    },
  };

  let lang = (urlParams.get('lang') || '').toLowerCase().startsWith('en') ? 'en' : 'vi';
  const T = (khoa) => CHUOI[lang][khoa];
  const localeHienTai = () => (lang === 'en' ? 'en-AU' : 'vi-VN');
  const xungHo = () => tenShop || T('xungHoMacDinh');

  // Trạng thái hiển thị dưới tên trợ lý: 'bot' | 'nguoi' | 'chuyen'
  let trangThai = 'bot';
  const KHOA_TRANG_THAI = { bot: 'trangThaiBot', nguoi: 'trangThaiNguoi', chuyen: 'trangThaiChuyen' };

  // Calculate api base url dynamically based on iframe path to support sub-path proxying
  const path = window.location.pathname;
  const prefixIndex = path.indexOf('/widget/index.html');
  const prefix = prefixIndex > 0 ? path.substring(0, prefixIndex) : '';
  const serverUrl = window.location.origin + prefix;

  const chatMessages = document.getElementById('chat-messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const closeBtn = document.getElementById('close-btn');
  const typingIndicator = document.getElementById('typing-indicator');
  const merchantName = document.getElementById('merchant-name');
  const operatorStatus = document.getElementById('operator-status');
  const xoaLichSuBtn = document.getElementById('xoa-lich-su-btn');
  const xoaDialog = document.getElementById('xoa-lich-su-dialog');
  const xoaDialogTitle = document.getElementById('xoa-dialog-title');
  const xoaDialogDesc = document.getElementById('xoa-dialog-desc');
  const xoaDialogNote = document.getElementById('xoa-dialog-note');
  const xoaDialogError = document.getElementById('xoa-dialog-error');
  const huyXoaBtn = document.getElementById('huy-xoa-btn');
  const xacNhanXoaBtn = document.getElementById('xac-nhan-xoa-btn');

  let sessionToken = '';
  let messagesCount = 0;
  let pollInterval = null;
  const visitorId = getOrCreateVisitorId();

  // Generate or read persistent guest visitorId
  function getOrCreateVisitorId() {
    let id = localStorage.getItem('vph_visitor_id');
    if (!id) {
      id = 'vis_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('vph_visitor_id', id);
    }
    return id;
  }

  // Áp chữ theo ngôn ngữ hiện tại cho các phần tử tĩnh và trạng thái
  function applyLang() {
    document.documentElement.lang = lang;
    chatInput.placeholder = T('placeholder');
    merchantName.textContent = tenShop ? T('tieuDeShop')(tenShop) : T('tieuDeMacDinh');
    operatorStatus.textContent = T(KHOA_TRANG_THAI[trangThai]);
    closeBtn.title = T('tieuDeDong');
    closeBtn.setAttribute('aria-label', T('tieuDeDong'));
    if (xoaLichSuBtn) {
      xoaLichSuBtn.title = T('tieuDeXoa');
      xoaLichSuBtn.setAttribute('aria-label', T('tieuDeXoa'));
    }
    if (xoaDialog) {
      xoaDialogTitle.textContent = T('tieuDeXoa') + '?';
      xoaDialogDesc.textContent = T('xacNhanXoa');
      xoaDialogNote.textContent = T('ghiChuXoa');
      huyXoaBtn.textContent = T('huyXoa');
      if (!xacNhanXoaBtn.disabled) xacNhanXoaBtn.textContent = T('nutXoa');
    }
  }

  // Lời chào + gợi ý nhờ mã đơn — hiện khi chưa có tin nhắn nào
  function renderWelcome() {
    chatMessages.innerHTML = `
      <div class="message system-message welcome-message">
        <div class="bubble">${escapeHtml(T('chao')(xungHo()))}</div>
      </div>
      <div class="message system-message welcome-message">
        <div class="bubble">${escapeHtml(T('gopY'))}</div>
      </div>
    `;
    messagesCount = 0;
  }

  // 1. Initialize Chat Session
  async function initSession() {
    try {
      const response = await fetch(`${serverUrl}/v1/chat/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Chatbot-Key': apiKey
        },
        body: JSON.stringify({
          visitorId,
          channelId: 'widget',
          currencyCode: 'VND',
          locale: localeHienTai()
        })
      });

      if (!response.ok) {
        throw new Error('Session initialization failed');
      }

      const data = await response.json();
      sessionToken = data.session_token;

      // Update header details based on tenant config
      if (data.tenant) {
        trangThai = 'bot';
        operatorStatus.textContent = T(KHOA_TRANG_THAI[trangThai]);
      }
      // SỬA BUG-R31: tiêu đề khung chat mang đúng tên thương hiệu khi trang
      // nhúng có truyền `data-ten-shop`; không truyền thì giữ tiêu đề mặc định.
      if (tenShop && merchantName) {
        merchantName.textContent = T('tieuDeShop')(tenShop);
      }

      // Load existing history immediately
      await loadHistory();
      // Start background polling for new messages (e.g. operator replies)
      startPolling();

    } catch (error) {
      console.error('[VPHChatbot] Error starting session:', error);
      appendSystemMessage(T('loiKetNoi'));
    }
  }

  // 2. Fetch and render chat history
  async function loadHistory() {
    if (!sessionToken) return;
    try {
      const response = await fetch(`${serverUrl}/v1/chat/history`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (response.ok) {
        const msgs = await response.json();
        if (msgs.length > 0) {
          chatMessages.innerHTML = '';
          msgs.forEach(msg => {
            if (msg.vai_tro === 'khach') {
              appendUserMessageUI(msg.noi_dung);
            } else if (msg.vai_tro === 'bot') {
              appendBotMessageUI(msg);
            } else if (msg.vai_tro === 'nguoi') {
              appendOperatorMessageUI(msg);
            }
          });
          messagesCount = msgs.length;
        } else {
          // If no history, make sure we show the welcome message.
          // Câu chào KHÔNG được gắn cứng tên một cửa hàng cụ thể: widget này
          // dùng chung cho mọi tenant, gắn cứng "Ẩm Thực Xứ Huế" làm khách của
          // Hasaki thấy sai tên shop (ảnh anh Sỹ gửi ngày 06/08/2026).
          // Tên đúng đi từ trang nhúng vào qua tham số `shop`.
          renderWelcome();
        }
      }
    } catch (e) {
      console.error("[VPHChatbot] Error loading history:", e);
    }
  }

  // 3. Background polling for operator replies
  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      if (!sessionToken) return;
      try {
        const response = await fetch(`${serverUrl}/v1/chat/history`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${sessionToken}`
          }
        });
        if (response.ok) {
          const msgs = await response.json();
          // If there are new messages, append them
          if (msgs.length > messagesCount) {
            const newMsgs = msgs.slice(messagesCount);
            newMsgs.forEach(msg => {
              if (msg.vai_tro === 'khach') {
                appendUserMessageUI(msg.noi_dung);
              } else if (msg.vai_tro === 'bot') {
                appendBotMessageUI(msg);
              } else if (msg.vai_tro === 'nguoi') {
                appendOperatorMessageUI(msg);
                trangThai = 'nguoi';
                operatorStatus.textContent = T(KHOA_TRANG_THAI[trangThai]);
              }
            });
            messagesCount = msgs.length;
          }
        }
      } catch (e) {
        console.error("[VPHChatbot] Polling error:", e);
      }
    }, 5000);
  }

  // 4. Render bubble elements
  function appendUserMessageUI(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message user-message';
    msgDiv.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    chatMessages.appendChild(msgDiv);
    scrollToBottom();
  }

  function appendBotMessageUI(msg) {
    const text = typeof msg === 'string' ? msg : msg.noi_dung;
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message bot-message';

    let html = `<div class="bubble">${formatMessageText(text)}`;
    if (msg && msg.dinh_kem) {
      try {
        const attachments = typeof msg.dinh_kem === 'string' ? JSON.parse(msg.dinh_kem) : msg.dinh_kem;
        if (Array.isArray(attachments)) {
          attachments.forEach(att => {
            // KHÔNG vẽ lại ảnh đã có sẵn trong nội dung tin nhắn.
            //
            // Tin nhắn thanh toán vừa chứa link ảnh Markdown ![...](url) trong
            // `noi_dung`, vừa lặp lại chính URL đó trong `dinh_kem` — khách
            // nhìn thấy MÃ QR HAI LẦN (lỗi anh Sỹ báo ngày 06/08/2026). Máy chủ
            // đã được sửa để không lặp nữa, nhưng các tin nhắn CŨ còn trong cơ
            // sở dữ liệu vẫn hỏng, nên chặn luôn ở tầng hiển thị.
            if (att.type === 'image' && !anhDaCoTrongVanBan(text, att.url)) {
              html += `<br/><img src="${escapeHtml(att.url)}" style="max-width:100%; border-radius:8px; margin-top:8px; display:block;"/>`;
            }
          });
        }
      } catch (e) {
        console.error("Failed to parse attachments:", e);
      }
    }
    html += `</div>`;

    msgDiv.innerHTML = html;
    chatMessages.appendChild(msgDiv);
    scrollToBottom();
  }

  function appendOperatorMessageUI(msg) {
    const text = typeof msg === 'string' ? msg : msg.noi_dung;
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message bot-message operator-message';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.style.backgroundColor = '#f3f4f6';
    bubble.style.color = '#1f2937';
    bubble.style.borderLeft = '4px solid #0d9488';

    let html = `<strong>${escapeHtml(T('nhanNhanVien'))}</strong> ${escapeHtml(text)}`;
    if (msg && msg.dinh_kem) {
      try {
        const attachments = typeof msg.dinh_kem === 'string' ? JSON.parse(msg.dinh_kem) : msg.dinh_kem;
        if (Array.isArray(attachments)) {
          attachments.forEach(att => {
            // Cùng lý do như ở tin nhắn bot: không vẽ lại ảnh đã có trong văn bản.
            if (att.type === 'image' && !anhDaCoTrongVanBan(text, att.url)) {
              html += `<br/><img src="${escapeHtml(att.url)}" style="max-width:100%; border-radius:8px; margin-top:8px; display:block;"/>`;
            }
          });
        }
      } catch (e) {
        console.error("Failed to parse attachments:", e);
      }
    }

    bubble.innerHTML = html;
    msgDiv.appendChild(bubble);
    chatMessages.appendChild(msgDiv);
    scrollToBottom();
  }

  function appendSystemMessage(text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message system-message';
    msgDiv.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    chatMessages.appendChild(msgDiv);
    scrollToBottom();
  }

  function createBotMessageContainer() {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message bot-message';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    msgDiv.appendChild(bubble);
    chatMessages.appendChild(msgDiv);
    return bubble;
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function showTyping() {
    typingIndicator.style.display = 'block';
    scrollToBottom();
  }

  function hideTyping() {
    typingIndicator.style.display = 'none';
  }

  function escapeHtml(unsafe) {
    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * Ảnh này đã được nhúng sẵn trong nội dung tin nhắn chưa?
   *
   * Dùng để khỏi vẽ trùng mã QR thanh toán: so khớp cả URL đầy đủ lẫn phần
   * đường dẫn (bỏ tham số truy vấn) vì URL VietQR có kèm số tiền và nội dung
   * chuyển khoản, đôi khi được mã hoá khác nhau đôi chút giữa hai chỗ.
   */
  function anhDaCoTrongVanBan(vanBan, url) {
    if (!vanBan || !url) return false;
    if (vanBan.indexOf(url) !== -1) return true;
    const duongDan = String(url).split('?')[0];
    return duongDan.length > 0 && vanBan.indexOf(duongDan) !== -1;
  }

  function formatMessageText(unsafe) {
    if (!unsafe) return "";
    let safe = escapeHtml(unsafe);
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/!\[([^\]]*)\]\((https?:\/\/[^\)]+|data:image\/png;base64,[A-Za-z0-9+\/=]+)\)/g, '<br/><img src="$2" alt="$1" style="max-width:100%; border-radius:8px; margin-top:8px; display:block;"/><br/>');
    safe = safe.replace(/\n/g, '<br/>');
    return safe;
  }

  // 5. Send Message & Handle SSE Stream Reader
  async function sendMessage(text) {
    if (!sessionToken) {
      await initSession();
    }
    if (!sessionToken) return;

    appendUserMessageUI(text);
    messagesCount++; // update local UI count to prevent appending duplicates during active send
    chatInput.value = '';
    showTyping();

    try {
      let response = await fetch(`${serverUrl}/v1/chat/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ text })
      });

      // Automatically refresh token on expired (HTTP 401)
      if (response.status === 401) {
        console.warn("[VPHChatbot] Session token expired. Re-initializing session...");
        await initSession();
        if (sessionToken) {
          response = await fetch(`${serverUrl}/v1/chat/message`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${sessionToken}`
            },
            body: JSON.stringify({ text })
          });
        }
      }

      hideTyping();

      if (!response.ok) {
        const errData = await response.json();
        appendSystemMessage(errData.error || T('guiThatBai'));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let botBubble = createBotMessageContainer();
      let responseText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunkStr = decoder.decode(value);
        const lines = chunkStr.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.substring(6).trim();
            if (!jsonStr) continue;

            try {
              const data = JSON.parse(jsonStr);

              if (data.type === 'chu') {
                responseText += data.value;
                botBubble.innerHTML = formatMessageText(responseText);
                scrollToBottom();
              } else if (data.type === 'chan_tien' || data.type === 'chan_claims') {
                botBubble.innerHTML = escapeHtml(data.thay_the);
                botBubble.style.borderColor = '#d97706';
                trangThai = 'chuyen';
                operatorStatus.textContent = T(KHOA_TRANG_THAI[trangThai]);
                scrollToBottom();
              } else if (data.type === 'trang_thai' && data.value === 'bi_tiep_quan') {
                appendSystemMessage(T('nhanVienThamGia'));
                trangThai = 'nguoi';
                operatorStatus.textContent = T(KHOA_TRANG_THAI[trangThai]);
                break;
              }
            } catch (e) {
              // Ignore partial chunk parsing errors
            }
          }
        }
      }

      // Sync message state with database to lock in counts
      await loadHistory();

    } catch (error) {
      hideTyping();
      console.error('[VPHChatbot] Message error:', error);
      appendSystemMessage(T('loiTruyenTin'));
    }
  }

  // 6. Event Listeners
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) {
      sendMessage(text);
    }
  });

  closeBtn.addEventListener('click', () => {
    window.parent.postMessage({ type: 'vph-chat-close' }, '*');
  });

  // ---------------------------------------------------------------------------
  // KHÁCH TỰ XOÁ LỊCH SỬ TRÒ CHUYỆN
  //
  // Quyền của chủ thể dữ liệu (Nghị định 13/2023) — khách bấm là xoá, không phải
  // liên hệ ai. Hỏi xác nhận vì thao tác không hoàn tác được, và nói rõ ĐƠN HÀNG
  // vẫn còn: khách xoá chat mà tưởng huỷ luôn đơn thì thành hiểu lầm tai hại.
  // ---------------------------------------------------------------------------
  if (xoaLichSuBtn) {
    let nutTruocModal = null;

    const dongXacNhanXoa = () => {
      if (!xoaDialog || xacNhanXoaBtn.disabled) return;
      xoaDialog.hidden = true;
      if (nutTruocModal) nutTruocModal.focus();
    };

    const moXacNhanXoa = () => {
      if (!sessionToken) return;
      nutTruocModal = document.activeElement;
      xoaDialogError.hidden = true;
      xoaDialogError.textContent = '';
      xoaDialog.hidden = false;
      requestAnimationFrame(() => huyXoaBtn.focus());
    };

    xoaLichSuBtn.addEventListener('click', moXacNhanXoa);
    huyXoaBtn.addEventListener('click', dongXacNhanXoa);
    xoaDialog.addEventListener('click', (event) => {
      if (event.target === xoaDialog) dongXacNhanXoa();
    });
    xoaDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dongXacNhanXoa();
        return;
      }
      if (event.key !== 'Tab') return;
      const dau = huyXoaBtn;
      const cuoi = xacNhanXoaBtn;
      if (event.shiftKey && document.activeElement === dau) {
        event.preventDefault();
        cuoi.focus();
      } else if (!event.shiftKey && document.activeElement === cuoi) {
        event.preventDefault();
        dau.focus();
      }
    });

    xacNhanXoaBtn.addEventListener('click', async () => {
      if (!sessionToken) return;

      xoaLichSuBtn.disabled = true;
      huyXoaBtn.disabled = true;
      xacNhanXoaBtn.disabled = true;
      xacNhanXoaBtn.textContent = T('dangXoa');
      try {
        const res = await fetch(`${serverUrl}/v1/chat/xoa-lich-su`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
          }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        // Dọn màn hình và mở phiên mới. Máy chủ đã đóng hội thoại cũ nên token
        // hiện tại trỏ vào một hội thoại rỗng — giữ nó lại thì tin nhắn tiếp
        // theo rơi vào hội thoại đã đóng.
        chatMessages.innerHTML =
          `<div class="message system-message"><div class="bubble">${escapeHtml(T('daXoa'))}</div></div>`;
        sessionToken = '';
        xoaDialog.hidden = true;
        await initSession();
      } catch (e) {
        console.error('[Widget] Xoá lịch sử lỗi:', e);
        xoaDialogError.textContent = T('xoaThatBai');
        xoaDialogError.hidden = false;
      } finally {
        xoaLichSuBtn.disabled = false;
        huyXoaBtn.disabled = false;
        xacNhanXoaBtn.disabled = false;
        xacNhanXoaBtn.textContent = T('nutXoa');
      }
    });
  }

  // Handle parent window messages
  window.addEventListener('message', (event) => {
    if (!event.data) return;

    if (event.data.type === 'vph-chat-open') {
      if (!sessionToken) {
        initSession();
      } else {
        loadHistory();
      }
    }

    // Trang đổi ngôn ngữ: đổi chữ ngay; nếu chưa có tin nhắn nào thì đổi luôn lời chào.
    if (event.data.type === 'vph-chat-lang') {
      const moi = String(event.data.lang || '').toLowerCase().startsWith('en') ? 'en' : 'vi';
      if (moi === lang) return;
      lang = moi;
      applyLang();
      if (messagesCount === 0) renderWelcome();
    }
  });

  // Start initialization
  applyLang();
  renderWelcome();
  initSession();
})();
