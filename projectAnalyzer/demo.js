/* demo.js - small built-in nRF54L15 sample project so the tool can be tried without a folder */
window.DEMO_FILES = [
{ path: 'src/main.c', content: String.raw`
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "ble/ble_service.h"
#include "sensors/temp_sensor.h"
#include "ui/led_ctrl.h"
#include "storage/settings_store.h"
#include "power/power_mgr.h"

LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

static void sensor_work_handler(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(sensor_work, sensor_work_handler);

static void sensor_work_handler(struct k_work *work)
{
	int16_t t_centi;

	if (temp_sensor_read(&t_centi) == 0) {
		ble_service_notify_temp(t_centi);
		settings_store_save_temp(t_centi);
	} else {
		led_ctrl_set_error(true);
	}
	power_mgr_activity();
	k_work_reschedule(&sensor_work, K_SECONDS(5));
}

int main(void)
{
	int err;

	LOG_INF("nRF54L15 demo started");

	err = led_ctrl_init();
	if (err) {
		return err;
	}
	err = settings_store_init();
	if (err) {
		led_ctrl_set_error(true);
	}
	err = temp_sensor_init();
	if (err) {
		led_ctrl_set_error(true);
	}
	ble_service_set_activity_cb(power_mgr_activity);
	err = ble_service_init();
	if (err) {
		LOG_ERR("BLE init failed");
		return err;
	}
	power_mgr_init();
	k_work_reschedule(&sensor_work, K_NO_WAIT);
	return 0;
}
` },
{ path: 'src/ble/ble_service.h', content: String.raw`
#ifndef BLE_SERVICE_H_
#define BLE_SERVICE_H_
#include <stdint.h>

int ble_service_init(void);
int ble_service_notify_temp(int16_t centi_deg);
void ble_service_stop(void);
bool ble_service_is_connected(void);
void ble_service_set_activity_cb(void (*cb)(void));

#endif
` },
{ path: 'src/ble/ble_service.c', content: String.raw`
#include <zephyr/kernel.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/settings/settings.h>
#include "ble_service.h"
#include "../ui/led_ctrl.h"
#include "../storage/settings_store.h"

static struct bt_conn *current_conn;
static void (*activity_cb)(void);

void ble_service_set_activity_cb(void (*cb)(void))
{
	activity_cb = cb;
}

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
};

static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		led_ctrl_set_error(true);
		return;
	}
	current_conn = bt_conn_ref(conn);
	led_ctrl_set_connected(true);
	if (activity_cb) {
		activity_cb();
	}
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}
	led_ctrl_set_connected(false);
	bt_le_adv_start(BT_LE_ADV_CONN, ad, ARRAY_SIZE(ad), NULL, 0);
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
};

static ssize_t read_temp(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			 void *buf, uint16_t len, uint16_t offset)
{
	int16_t v = settings_store_load_temp();

	return bt_gatt_attr_read(conn, attr, buf, len, offset, &v, sizeof(v));
}

BT_GATT_SERVICE_DEFINE(temp_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_ESS),
	BT_GATT_CHARACTERISTIC(BT_UUID_TEMPERATURE, BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ, read_temp, NULL, NULL),
);

int ble_service_init(void)
{
	int err = bt_enable(NULL);

	if (err) {
		return err;
	}
	settings_load();
	return bt_le_adv_start(BT_LE_ADV_CONN, ad, ARRAY_SIZE(ad), NULL, 0);
}

int ble_service_notify_temp(int16_t centi_deg)
{
	if (!current_conn) {
		return -ENOTCONN;
	}
	return bt_gatt_notify(current_conn, &temp_svc.attrs[1], &centi_deg, sizeof(centi_deg));
}

bool ble_service_is_connected(void)
{
	return current_conn != NULL;
}

void ble_service_stop(void)
{
	if (current_conn) {
		bt_conn_disconnect(current_conn, BT_HCI_ERR_REMOTE_USER_TERM_CONN);
	}
	bt_le_adv_stop();
}
` },
{ path: 'src/sensors/temp_sensor.h', content: String.raw`
#ifndef TEMP_SENSOR_H_
#define TEMP_SENSOR_H_
#include <stdint.h>

int temp_sensor_init(void);
int temp_sensor_read(int16_t *centi_deg);
void temp_sensor_suspend(void);

#endif
` },
{ path: 'src/sensors/temp_sensor.c', content: String.raw`
#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>
#include "temp_sensor.h"

static const struct device *const temp_dev = DEVICE_DT_GET(DT_NODELABEL(temp));
static K_MUTEX_DEFINE(sensor_lock);

static int16_t to_centi(const struct sensor_value *val)
{
	return (int16_t)(val->val1 * 100 + val->val2 / 10000);
}

int temp_sensor_init(void)
{
	if (!device_is_ready(temp_dev)) {
		return -ENODEV;
	}
	return 0;
}

int temp_sensor_read(int16_t *centi_deg)
{
	struct sensor_value val;
	int err;

	k_mutex_lock(&sensor_lock, K_FOREVER);
	err = sensor_sample_fetch(temp_dev);
	if (err == 0) {
		err = sensor_channel_get(temp_dev, SENSOR_CHAN_DIE_TEMP, &val);
	}
	k_mutex_unlock(&sensor_lock);

	if (err == 0) {
		*centi_deg = to_centi(&val);
	}
	return err;
}

void temp_sensor_suspend(void)
{
	k_mutex_lock(&sensor_lock, K_FOREVER);
	pm_device_action_run(temp_dev, PM_DEVICE_ACTION_SUSPEND);
	k_mutex_unlock(&sensor_lock);
}
` },
{ path: 'src/ui/led_ctrl.h', content: String.raw`
#ifndef LED_CTRL_H_
#define LED_CTRL_H_
#include <stdbool.h>

int led_ctrl_init(void);
void led_ctrl_set_connected(bool on);
void led_ctrl_set_error(bool on);
void led_ctrl_all_off(void);

#endif
` },
{ path: 'src/ui/led_ctrl.c', content: String.raw`
#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>
#include <nrfx_gpiote.h>
#include "led_ctrl.h"

static const struct gpio_dt_spec led_conn = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static const struct gpio_dt_spec led_err = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);
static struct k_timer blink_timer;
static bool error_state;

static void blink_timer_handler(struct k_timer *timer)
{
	if (error_state) {
		gpio_pin_toggle_dt(&led_err);
	}
}

int led_ctrl_init(void)
{
	int err;

	if (!gpio_is_ready_dt(&led_conn) || !gpio_is_ready_dt(&led_err)) {
		return -ENODEV;
	}
	err = gpio_pin_configure_dt(&led_conn, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}
	err = gpio_pin_configure_dt(&led_err, GPIO_OUTPUT_INACTIVE);
	k_timer_init(&blink_timer, blink_timer_handler, NULL);
	return err;
}

void led_ctrl_set_connected(bool on)
{
	gpio_pin_set_dt(&led_conn, on);
}

void led_ctrl_set_error(bool on)
{
	error_state = on;
	if (on) {
		k_timer_start(&blink_timer, K_MSEC(250), K_MSEC(250));
	} else {
		k_timer_stop(&blink_timer);
		gpio_pin_set_dt(&led_err, 0);
	}
}

void led_ctrl_all_off(void)
{
	led_ctrl_set_error(false);
	led_ctrl_set_connected(false);
	nrfx_gpiote_pin_uninit(0);
}
` },
{ path: 'src/storage/settings_store.h', content: String.raw`
#ifndef SETTINGS_STORE_H_
#define SETTINGS_STORE_H_
#include <stdint.h>

int settings_store_init(void);
int settings_store_save_temp(int16_t centi_deg);
int16_t settings_store_load_temp(void);

#endif
` },
{ path: 'src/storage/settings_store.c', content: String.raw`
#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>
#include "settings_store.h"

static int16_t last_temp;

static int store_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg)
{
	if (len != sizeof(last_temp)) {
		return -EINVAL;
	}
	return read_cb(cb_arg, &last_temp, sizeof(last_temp)) < 0 ? -EIO : 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(app_store, "app", NULL, store_set, NULL, NULL);

int settings_store_init(void)
{
	int err = settings_subsys_init();

	if (err) {
		return err;
	}
	return settings_load_subtree("app");
}

int settings_store_save_temp(int16_t centi_deg)
{
	last_temp = centi_deg;
	return settings_save_one("app/temp", &last_temp, sizeof(last_temp));
}

int16_t settings_store_load_temp(void)
{
	return last_temp;
}
` },
{ path: 'src/power/power_mgr.h', content: String.raw`
#ifndef POWER_MGR_H_
#define POWER_MGR_H_

void power_mgr_init(void);
void power_mgr_activity(void);

#endif
` },
{ path: 'src/power/power_mgr.c', content: String.raw`
#include <zephyr/kernel.h>
#include <zephyr/sys/poweroff.h>
#include "power_mgr.h"
#include "../ble/ble_service.h"
#include "../ui/led_ctrl.h"
#include "../sensors/temp_sensor.h"

#define IDLE_TIMEOUT_S 600

static struct k_work_delayable idle_work;

static void idle_work_handler(struct k_work *work)
{
	if (ble_service_is_connected()) {
		power_mgr_activity();
		return;
	}
	ble_service_stop();
	temp_sensor_suspend();
	led_ctrl_all_off();
	sys_poweroff();
}

void power_mgr_init(void)
{
	k_work_init_delayable(&idle_work, idle_work_handler);
	k_work_schedule(&idle_work, K_SECONDS(IDLE_TIMEOUT_S));
}

void power_mgr_activity(void)
{
	k_work_reschedule(&idle_work, K_SECONDS(IDLE_TIMEOUT_S));
}
` }
];
