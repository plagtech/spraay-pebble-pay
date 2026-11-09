#include <pebble.h>

// Values of PaymentStatus. Keep in sync with src/pkjs/index.js.
typedef enum {
  STATUS_REQUEST = 0,
  STATUS_SENT = 1,
  STATUS_DENIED = 2,
  STATUS_FAILED = 3,
  STATUS_UNKNOWN = 4,
  STATUS_SENDING = 5  // Local to the watch, never sent by the phone.
} PaymentStatus;

#define INBOX_SIZE 256
#define OUTBOX_SIZE 64

#define SERVICE_LEN 32
#define AMOUNT_LEN 16
#define URL_LEN 64
#define TX_HASH_LEN 16
#define DETAIL_LEN 32

#define HISTORY_MAX 5
#define HISTORY_SERVICE_LEN 24

// An unanswered request is denied, matching spraay-device-pay's approval timeout.
#define DECISION_TIMEOUT_MS 60000
// Longer than the phone's 30 second payment request, so its answer normally arrives first.
#define RESULT_TIMEOUT_MS 45000
// Ignores an Approve press that was already under way when a request popped up.
#define APPROVE_ARM_DELAY_MS 750
#define STATUS_DISMISS_MS 4000

#define PERSIST_KEY_HISTORY_COUNT 1
#define PERSIST_KEY_HISTORY 2

typedef struct {
  char service[HISTORY_SERVICE_LEN];
  char amount[AMOUNT_LEN];
  uint8_t status;
} HistoryEntry;

typedef struct {
  int32_t id;
  char service[SERVICE_LEN];
  char amount[AMOUNT_LEN];
  char url[URL_LEN];
} PaymentRequest;

static Window *s_history_window;
static MenuLayer *s_menu_layer;

static Window *s_approval_window;
static Layer *s_approval_layer;

static Window *s_status_window;
static Layer *s_status_layer;

static HistoryEntry s_history[HISTORY_MAX];
static uint8_t s_history_count;

static PaymentRequest s_request;
static bool s_request_active;
static bool s_approve_armed;
static time_t s_request_shown_at;
// The request approved on the watch whose result has not arrived. Zero means none.
static int32_t s_awaiting_id;

static PaymentStatus s_status;
static char s_status_detail[DETAIL_LEN];

static AppTimer *s_decision_timer;
static AppTimer *s_arm_timer;
static AppTimer *s_result_timer;
static AppTimer *s_dismiss_timer;

static void cancel_timer(AppTimer **timer) {
  if (*timer) {
    app_timer_cancel(*timer);
    *timer = NULL;
  }
}

static void copy_string(char *dest, const char *src, size_t size) {
  strncpy(dest, src, size - 1);
  dest[size - 1] = '\0';
}

static const char *status_title(PaymentStatus status) {
  switch (status) {
    case STATUS_SENT: return "Payment sent";
    case STATUS_DENIED: return "Denied";
    case STATUS_FAILED: return "Payment failed";
    case STATUS_SENDING: return "Sending...";
    default: return "Status unknown";
  }
}

static const char *status_short_label(PaymentStatus status) {
  switch (status) {
    case STATUS_SENT: return "Sent";
    case STATUS_DENIED: return "Denied";
    case STATUS_FAILED: return "Failed";
    default: return "Unknown";
  }
}

// History ---------------------------------------------------------------------

static void history_load(void) {
  if (!persist_exists(PERSIST_KEY_HISTORY_COUNT) || !persist_exists(PERSIST_KEY_HISTORY)) {
    return;
  }
  int count = persist_read_int(PERSIST_KEY_HISTORY_COUNT);
  if (count < 0 || count > HISTORY_MAX) {
    return;
  }
  persist_read_data(PERSIST_KEY_HISTORY, s_history, sizeof(s_history));
  for (int i = 0; i < count; i++) {
    s_history[i].service[HISTORY_SERVICE_LEN - 1] = '\0';
    s_history[i].amount[AMOUNT_LEN - 1] = '\0';
  }
  s_history_count = count;
}

static void history_add(const PaymentRequest *request, PaymentStatus status) {
  memmove(&s_history[1], &s_history[0], sizeof(HistoryEntry) * (HISTORY_MAX - 1));
  copy_string(s_history[0].service, request->service, HISTORY_SERVICE_LEN);
  copy_string(s_history[0].amount, request->amount, AMOUNT_LEN);
  s_history[0].status = status;
  if (s_history_count < HISTORY_MAX) {
    s_history_count++;
  }
  persist_write_data(PERSIST_KEY_HISTORY, s_history, sizeof(s_history));
  persist_write_int(PERSIST_KEY_HISTORY_COUNT, s_history_count);
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
}

static uint16_t menu_get_num_rows(MenuLayer *menu, uint16_t section, void *context) {
  return s_history_count > 0 ? s_history_count : 1;
}

static int16_t menu_get_header_height(MenuLayer *menu, uint16_t section, void *context) {
  return PBL_IF_RECT_ELSE(MENU_CELL_BASIC_HEADER_HEIGHT, 0);
}

static void menu_draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *context) {
  menu_cell_basic_header_draw(ctx, cell, "Recent payments");
}

static int16_t menu_get_cell_height(MenuLayer *menu, MenuIndex *index, void *context) {
#if defined(PBL_ROUND)
  return menu_layer_is_index_selected(menu, index) ? MENU_CELL_ROUND_FOCUSED_SHORT_CELL_HEIGHT
                                                   : MENU_CELL_ROUND_UNFOCUSED_TALL_CELL_HEIGHT;
#else
  return 44;
#endif
}

static void menu_draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *context) {
  if (s_history_count == 0) {
    menu_cell_basic_draw(ctx, cell, "No payments yet", "Waiting for requests", NULL);
    return;
  }
  const HistoryEntry *entry = &s_history[index->row];
  char subtitle[AMOUNT_LEN + 16];
  // Status first, because a long amount would otherwise push it off the row.
  snprintf(subtitle, sizeof(subtitle), "%s %s USDC",
           status_short_label((PaymentStatus)entry->status), entry->amount);
  menu_cell_basic_draw(ctx, cell, entry->service, subtitle, NULL);
}

static void history_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_menu_layer = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_rows = menu_get_num_rows,
    .get_header_height = menu_get_header_height,
    .draw_header = menu_draw_header,
    .get_cell_height = menu_get_cell_height,
    .draw_row = menu_draw_row,
  });
#if defined(PBL_ROUND)
  menu_layer_set_center_focused(s_menu_layer, true);
#endif
#if defined(PBL_COLOR)
  menu_layer_set_highlight_colors(s_menu_layer, GColorCobaltBlue, GColorWhite);
#endif
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void history_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

// Status screen ---------------------------------------------------------------

static GColor status_background(PaymentStatus status) {
#if defined(PBL_COLOR)
  switch (status) {
    case STATUS_SENT: return GColorDarkGreen;
    case STATUS_DENIED: return GColorDarkCandyAppleRed;
    case STATUS_SENDING: return GColorOxfordBlue;
    default: return GColorWindsorTan;
  }
#else
  return GColorBlack;
#endif
}

static void status_layer_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  const int16_t inset = PBL_IF_ROUND_ELSE(20, 6);
  const int16_t width = bounds.size.w - (2 * inset);
  GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
  GFont detail_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  const char *title = status_title(s_status);

  GRect title_frame = GRect(inset, 0, width, bounds.size.h);
  GSize title_size = graphics_text_layout_get_content_size(
      title, title_font, title_frame, GTextOverflowModeWordWrap, GTextAlignmentCenter);
  GRect detail_frame = GRect(inset, 0, width, bounds.size.h);
  GSize detail_size = graphics_text_layout_get_content_size(
      s_status_detail, detail_font, detail_frame, GTextOverflowModeWordWrap, GTextAlignmentCenter);

  title_frame.origin.y = (bounds.size.h - title_size.h - detail_size.h) / 2 - 6;
  title_frame.size.h = title_size.h + 4;
  detail_frame.origin.y = title_frame.origin.y + title_size.h + 4;
  detail_frame.size.h = detail_size.h + 4;

  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, title, title_font, title_frame, GTextOverflowModeWordWrap,
                     GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, s_status_detail, detail_font, detail_frame, GTextOverflowModeWordWrap,
                     GTextAlignmentCenter, NULL);
}

static void status_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_status_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_status_layer, status_layer_update);
  layer_add_child(root, s_status_layer);
}

static void status_window_unload(Window *window) {
  layer_destroy(s_status_layer);
  s_status_layer = NULL;
  // Closed with Back: its auto-dismiss must not fire against a later status.
  if (!window_stack_contains_window(window) && s_dismiss_timer) {
    app_timer_cancel(s_dismiss_timer);
    s_dismiss_timer = NULL;
  }
}

static void dismiss_timer_handler(void *data) {
  s_dismiss_timer = NULL;
  window_stack_remove(s_status_window, true);
}

static void show_status(PaymentStatus status, const char *detail) {
  s_status = status;
  copy_string(s_status_detail, detail, DETAIL_LEN);
  window_set_background_color(s_status_window, status_background(status));
  if (window_stack_contains_window(s_status_window)) {
    layer_mark_dirty(window_get_root_layer(s_status_window));
  } else {
    window_stack_push(s_status_window, true);
  }
  cancel_timer(&s_dismiss_timer);
  if (status != STATUS_SENDING) {
    s_dismiss_timer = app_timer_register(STATUS_DISMISS_MS, dismiss_timer_handler, NULL);
  }
}

// Records the outcome of the approved request the watch was waiting on.
static void finish_awaiting(PaymentStatus status, const char *detail) {
  cancel_timer(&s_result_timer);
  s_awaiting_id = 0;
  history_add(&s_request, status);
  show_status(status, detail);
  light_enable_interaction();
  if (status == STATUS_SENT) {
    vibes_short_pulse();
  } else {
    vibes_long_pulse();
  }
}

static void result_timer_handler(void *data) {
  s_result_timer = NULL;
  finish_awaiting(STATUS_UNKNOWN, "Check your phone");
}

// Approval screen -------------------------------------------------------------

static bool send_decision(int32_t id, bool approved) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    return false;
  }
  dict_write_int32(out, MESSAGE_KEY_PaymentId, id);
  dict_write_int32(out, MESSAGE_KEY_UserDecision, approved ? 1 : 0);
  return app_message_outbox_send() == APP_MSG_OK;
}

// Ends the prompt. Only an explicit Approve press reaches this with approved set.
static void decide(bool approved, const char *denied_detail) {
  if (!s_request_active) {
    return;
  }
  s_request_active = false;
  s_approve_armed = false;
  cancel_timer(&s_decision_timer);
  cancel_timer(&s_arm_timer);

  bool sent = send_decision(s_request.id, approved);
  if (approved && sent) {
    s_awaiting_id = s_request.id;
    show_status(STATUS_SENDING, s_request.amount);
    s_result_timer = app_timer_register(RESULT_TIMEOUT_MS, result_timer_handler, NULL);
  } else if (approved) {
    // Nothing left the watch, so the phone cannot have paid.
    history_add(&s_request, STATUS_FAILED);
    show_status(STATUS_FAILED, "Phone not reachable");
  } else {
    history_add(&s_request, STATUS_DENIED);
    show_status(STATUS_DENIED, denied_detail);
  }
  window_stack_remove(s_approval_window, false);
}

static void decision_timer_handler(void *data) {
  s_decision_timer = NULL;
  // Checked against the clock because this timer has been seen firing tens of seconds early in the
  // aplite emulator. A clock moved backwards gives an out-of-range value, which denies.
  const int32_t remaining_s = (DECISION_TIMEOUT_MS / 1000) - (int32_t)(time(NULL) - s_request_shown_at);
  if (remaining_s > 0 && remaining_s <= (DECISION_TIMEOUT_MS / 1000)) {
    s_decision_timer = app_timer_register(remaining_s * 1000, decision_timer_handler, NULL);
    return;
  }
  decide(false, "Timed out");
}

static void arm_timer_handler(void *data) {
  s_arm_timer = NULL;
  s_approve_armed = true;
}

static void approve_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_approve_armed) {
    decide(true, NULL);
  }
}

static void deny_click_handler(ClickRecognizerRef recognizer, void *context) {
  decide(false, "Not paid");
}

static void approval_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, approve_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, deny_click_handler);
  window_single_click_subscribe(BUTTON_ID_BACK, deny_click_handler);
}

static int16_t draw_text_block(GContext *ctx, const char *text, GFont font, GRect box, int16_t y,
                               GTextAlignment alignment) {
  GRect frame = GRect(box.origin.x, y, box.size.w, box.size.h - y);
  GSize size = graphics_text_layout_get_content_size(text, font, frame, GTextOverflowModeWordWrap,
                                                     alignment);
  frame.size.h = size.h + 4;
  graphics_draw_text(ctx, text, font, frame, GTextOverflowModeWordWrap, alignment, NULL);
  return y + size.h + 2;
}

// The largest font that fits the amount on one line. The system's word wrap can insert hyphens,
// and an amount must be displayed exactly as it will be paid.
static GFont amount_font(const char *amount, GRect box, GTextAlignment alignment) {
  static const char *const font_keys[] = {
    FONT_KEY_GOTHIC_28_BOLD, FONT_KEY_GOTHIC_24_BOLD, FONT_KEY_GOTHIC_18_BOLD
  };
  const size_t count = ARRAY_LENGTH(font_keys);
  for (size_t i = 0; i < count - 1; i++) {
    GFont font = fonts_get_system_font(font_keys[i]);
    GSize one_line = graphics_text_layout_get_content_size("0", font, box,
                                                           GTextOverflowModeWordWrap, alignment);
    GSize size = graphics_text_layout_get_content_size(amount, font, box,
                                                       GTextOverflowModeWordWrap, alignment);
    if (size.h <= one_line.h) {
      return font;
    }
  }
  return fonts_get_system_font(font_keys[count - 1]);
}

static void draw_approve_icon(GContext *ctx, GPoint c) {
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorGreen, GColorWhite));
  graphics_draw_line(ctx, GPoint(c.x - 7, c.y), GPoint(c.x - 2, c.y + 6));
  graphics_draw_line(ctx, GPoint(c.x - 2, c.y + 6), GPoint(c.x + 8, c.y - 6));
}

static void draw_deny_icon(GContext *ctx, GPoint c) {
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorWhite));
  graphics_draw_line(ctx, GPoint(c.x - 6, c.y - 6), GPoint(c.x + 6, c.y + 6));
  graphics_draw_line(ctx, GPoint(c.x - 6, c.y + 6), GPoint(c.x + 6, c.y - 6));
}

static void approval_layer_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
#if defined(PBL_ROUND)
  const GRect box = GRect(36, 24, bounds.size.w - 72, bounds.size.h - 24);
  const GTextAlignment alignment = GTextAlignmentCenter;
  const GPoint approve_at = GPoint(bounds.size.w - 18, bounds.size.h / 3);
  const GPoint deny_at = GPoint(bounds.size.w - 18, (bounds.size.h * 2) / 3);
#else
  const GRect box = GRect(6, 0, bounds.size.w - 36, bounds.size.h);
  const GTextAlignment alignment = GTextAlignmentLeft;
  const GPoint approve_at = GPoint(bounds.size.w - 15, bounds.size.h / 4);
  const GPoint deny_at = GPoint(bounds.size.w - 15, (bounds.size.h * 3) / 4);
#endif

  graphics_context_set_text_color(ctx, GColorWhite);
  int16_t y = box.origin.y;
  y = draw_text_block(ctx, s_request.amount, amount_font(s_request.amount, box, alignment), box, y,
                      alignment);
  y = draw_text_block(ctx, "USDC", fonts_get_system_font(FONT_KEY_GOTHIC_14), box, y, alignment);
  y = draw_text_block(ctx, s_request.service, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), box,
                      y, alignment);
  draw_text_block(ctx, s_request.url, fonts_get_system_font(FONT_KEY_GOTHIC_14), box, y, alignment);

  graphics_context_set_stroke_width(ctx, 3);
  draw_approve_icon(ctx, approve_at);
  draw_deny_icon(ctx, deny_at);
}

static void approval_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_approval_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_approval_layer, approval_layer_update);
  layer_add_child(root, s_approval_layer);
}

static void approval_window_unload(Window *window) {
  layer_destroy(s_approval_layer);
  s_approval_layer = NULL;
}

static void show_approval(void) {
  s_request_active = true;
  s_approve_armed = false;
  s_request_shown_at = time(NULL);
  cancel_timer(&s_decision_timer);
  cancel_timer(&s_arm_timer);
  s_decision_timer = app_timer_register(DECISION_TIMEOUT_MS, decision_timer_handler, NULL);
  s_arm_timer = app_timer_register(APPROVE_ARM_DELAY_MS, arm_timer_handler, NULL);

  if (window_stack_contains_window(s_approval_window)) {
    layer_mark_dirty(window_get_root_layer(s_approval_window));
  } else {
    window_stack_push(s_approval_window, true);
  }
  light_enable_interaction();
  vibes_double_pulse();
}

// AppMessage ------------------------------------------------------------------

static bool read_string(DictionaryIterator *iter, uint32_t key, char *dest, size_t size) {
  Tuple *tuple = dict_find(iter, key);
  if (!tuple || tuple->type != TUPLE_CSTRING || tuple->value->cstring[0] == '\0') {
    return false;
  }
  copy_string(dest, tuple->value->cstring, size);
  return true;
}

static void handle_request(DictionaryIterator *iter, int32_t id) {
  // Parsed into a copy so that a malformed message cannot disturb a request being displayed.
  PaymentRequest request;
  request.id = id;
  if (!read_string(iter, MESSAGE_KEY_PaymentService, request.service, SERVICE_LEN) ||
      !read_string(iter, MESSAGE_KEY_PaymentAmount, request.amount, AMOUNT_LEN) ||
      !read_string(iter, MESSAGE_KEY_PaymentUrl, request.url, URL_LEN)) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Ignoring incomplete payment request");
    return;
  }
  s_request = request;
  show_approval();
}

static void handle_result(DictionaryIterator *iter, int32_t id, PaymentStatus status) {
  if (id != s_awaiting_id || s_awaiting_id == 0) {
    return;
  }
  char detail[DETAIL_LEN] = "";
  if (status == STATUS_SENT) {
    read_string(iter, MESSAGE_KEY_TxHash, detail, TX_HASH_LEN);
  } else if (status == STATUS_UNKNOWN) {
    copy_string(detail, "Check your phone", DETAIL_LEN);
  } else if (status != STATUS_DENIED && status != STATUS_FAILED) {
    status = STATUS_UNKNOWN;
    copy_string(detail, "Check your phone", DETAIL_LEN);
  }
  finish_awaiting(status, detail);
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *id = dict_find(iter, MESSAGE_KEY_PaymentId);
  Tuple *status = dict_find(iter, MESSAGE_KEY_PaymentStatus);
  if (!id || !status) {
    return;
  }
  if (status->value->int32 == STATUS_REQUEST) {
    handle_request(iter, id->value->int32);
  } else {
    handle_result(iter, id->value->int32, (PaymentStatus)status->value->int32);
  }
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  // The phone may or may not have seen an approval that was not acknowledged.
  if (s_awaiting_id != 0) {
    finish_awaiting(STATUS_UNKNOWN, "Check your phone");
  }
}

// App lifecycle ---------------------------------------------------------------

static Window *create_window(WindowHandler load, WindowHandler unload) {
  Window *window = window_create();
  window_set_window_handlers(window, (WindowHandlers) { .load = load, .unload = unload });
  return window;
}

static void init(void) {
  history_load();

  s_status_window = create_window(status_window_load, status_window_unload);
  s_approval_window = create_window(approval_window_load, approval_window_unload);
  window_set_background_color(s_approval_window, GColorBlack);
  window_set_click_config_provider(s_approval_window, approval_click_config);
  s_history_window = create_window(history_window_load, history_window_unload);
  window_stack_push(s_history_window, true);

  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(INBOX_SIZE, OUTBOX_SIZE);
}

static void deinit(void) {
  window_destroy(s_history_window);
  window_destroy(s_approval_window);
  window_destroy(s_status_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
