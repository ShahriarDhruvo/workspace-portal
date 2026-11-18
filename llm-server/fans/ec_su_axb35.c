// SPDX-License-Identifier: GPL-2.0
/*
 * Embedded controller of the Sixunited AXB35-02 board in the Bosgame M5, under /sys/class/ec_su_axb35:
 * fan speeds, a duty for the two APU fans, the EC's temperature and the firmware's power profile.
 *
 * Reduced from https://github.com/cmetz/ec-su_axb35-linux at f62c2c2. The duty registers and their
 * write and read-back are those of crmaris/FanControl.AXB35.
 *
 * A duty is a lease of 10 seconds: written again in time it holds, otherwise the fan goes back to the
 * firmware. A controller that died or hangs cannot keep a fan at a low duty.
 */
#include <linux/acpi.h>
#include <linux/delay.h>
#include <linux/device.h>
#include <linux/dmi.h>
#include <linux/jiffies.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/string.h>
#include <linux/workqueue.h>

#define TEMP_REG       0x70
#define POWER_MODE_REG 0x31
#define DUTY_LEASE_MS  10000

struct ec_fan {
	const char *name;
	u8 rpm_reg;			/* high byte; the low byte is the next register */
	u8 duty_reg;			/* 0: the fan has none */
	u8 duty;			/* held percent, 0: the firmware has the fan */
	int duty_error;			/* of the last duty write */
	bool release_pending;		/* the register must still be written 0 */
	unsigned long duty_deadline;
	struct device *dev;
};

/* release_pending: a duty the EC kept over a reset is released at load. */
static struct ec_fan ec_fans[] = {
	{ .name = "fan1", .rpm_reg = 0x35, .duty_reg = 0x33, .release_pending = true },
	{ .name = "fan2", .rpm_reg = 0x37, .duty_reg = 0x34, .release_pending = true },
	{ .name = "fan3", .rpm_reg = 0x28 },
};
static const char *const power_modes[] = { "balanced", "performance", "quiet" };	/* the register's 0, 1, 2 */

static struct class *ec_class;
static struct device *temp_dev, *apu_dev;
static DEFINE_MUTEX(duty_lock);

static ssize_t rpm_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	struct ec_fan *fan = dev_get_drvdata(dev);
	u8 high, low;
	u16 rpm;

	if (ec_read(fan->rpm_reg, &high) || ec_read(fan->rpm_reg + 1, &low))
		return -EIO;
	rpm = high << 8 | low;
	if (fan == &ec_fans[2] && rpm == 8000)	/* what fan3 reports just before it stops */
		rpm = 0;
	return sysfs_emit(buf, "%u\n", rpm);
}
static DEVICE_ATTR_RO(rpm);

/* 0x80 | percent holds a duty, 0 gives the fan back to the firmware. */
static int write_duty_verified(struct ec_fan *fan, u8 duty)
{
	u8 want = duty ? 0x80 | duty : 0, got;
	int i;

	for (i = 0; i < 3; i++) {
		if (!ec_write(fan->duty_reg, want) && !ec_read(fan->duty_reg, &got) && got == want)
			return 0;
		msleep(5);
	}
	return -EIO;
}

static ssize_t duty_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	struct ec_fan *fan = dev_get_drvdata(dev);
	unsigned int duty;

	mutex_lock(&duty_lock);
	duty = fan->duty;
	mutex_unlock(&duty_lock);
	return sysfs_emit(buf, "%u\n", duty);
}

static ssize_t duty_store(struct device *dev, struct device_attribute *attr, const char *buf, size_t count)
{
	struct ec_fan *fan = dev_get_drvdata(dev);
	unsigned int duty;
	int ret;

	if (kstrtouint(buf, 10, &duty) || (duty && (duty < 40 || duty > 95)))
		return -EINVAL;
	mutex_lock(&duty_lock);
	ret = write_duty_verified(fan, duty);
	fan->duty_error = ret;
	fan->duty = ret ? 0 : duty;
	fan->duty_deadline = jiffies + msecs_to_jiffies(DUTY_LEASE_MS);
	/* After a failed write the register may hold anything: release, and the worker retries that. */
	fan->release_pending = ret && write_duty_verified(fan, 0);
	mutex_unlock(&duty_lock);
	return ret ? ret : count;
}
static DEVICE_ATTR_RW(duty);

static ssize_t duty_error_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	struct ec_fan *fan = dev_get_drvdata(dev);
	int error;

	mutex_lock(&duty_lock);
	error = fan->duty_error;
	mutex_unlock(&duty_lock);
	return sysfs_emit(buf, "%d\n", error);
}
static DEVICE_ATTR_RO(duty_error);

static ssize_t duty_raw_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	struct ec_fan *fan = dev_get_drvdata(dev);
	u8 value;
	int ret;

	mutex_lock(&duty_lock);
	ret = ec_read(fan->duty_reg, &value);
	mutex_unlock(&duty_lock);
	return ret ? -EIO : sysfs_emit(buf, "%u\n", value);
}
static DEVICE_ATTR_RO(duty_raw);

static ssize_t temp_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	u8 temp;

	return ec_read(TEMP_REG, &temp) ? -EIO : sysfs_emit(buf, "%u\n", temp);
}
static DEVICE_ATTR_RO(temp);

static ssize_t power_mode_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	u8 mode;

	if (ec_read(POWER_MODE_REG, &mode))
		return -EIO;
	return mode < ARRAY_SIZE(power_modes) ? sysfs_emit(buf, "%s\n", power_modes[mode]) : -EINVAL;
}

static ssize_t power_mode_store(struct device *dev, struct device_attribute *attr, const char *buf, size_t count)
{
	int mode = sysfs_match_string(power_modes, buf);

	if (mode < 0)
		return -EINVAL;
	return ec_write(POWER_MODE_REG, mode) ? -EIO : count;
}
static DEVICE_ATTR_RW(power_mode);

static struct attribute *fan_attrs[] = { &dev_attr_rpm.attr, NULL };
ATTRIBUTE_GROUPS(fan);
static struct attribute *duty_fan_attrs[] = {
	&dev_attr_rpm.attr, &dev_attr_duty.attr, &dev_attr_duty_error.attr, &dev_attr_duty_raw.attr, NULL
};
ATTRIBUTE_GROUPS(duty_fan);
static struct attribute *temp_attrs[] = { &dev_attr_temp.attr, NULL };
ATTRIBUTE_GROUPS(temp);
static struct attribute *apu_attrs[] = { &dev_attr_power_mode.attr, NULL };
ATTRIBUTE_GROUPS(apu);

/* Every second: ends a lease that ran out, writes each held duty again, retries a release that failed. */
static void duty_worker(struct work_struct *work);
static DECLARE_DELAYED_WORK(duty_work, duty_worker);

static void duty_worker(struct work_struct *work)
{
	struct ec_fan *fan;

	mutex_lock(&duty_lock);
	for (fan = ec_fans; fan < ec_fans + ARRAY_SIZE(ec_fans); fan++) {
		if (fan->duty && time_after_eq(jiffies, fan->duty_deadline)) {
			fan->duty = 0;
			fan->release_pending = true;
		}
		if (!fan->duty_reg || (!fan->duty && !fan->release_pending))
			continue;
		if (write_duty_verified(fan, fan->duty)) {
			fan->duty_error = -EIO;
			fan->duty = 0;
			fan->release_pending = true;
			pr_err_ratelimited("ec_su_axb35: %s: duty write failed, releasing the fan\n", fan->name);
		} else if (!fan->duty) {
			fan->release_pending = false;
		}
	}
	mutex_unlock(&duty_lock);
	schedule_delayed_work(&duty_work, HZ);
}

static void ec_su_axb35_remove(void)
{
	struct ec_fan *fan;

	cancel_delayed_work_sync(&duty_work);
	for (fan = ec_fans; fan < ec_fans + ARRAY_SIZE(ec_fans); fan++)
		if (!IS_ERR(fan->dev))
			device_unregister(fan->dev);
	if (!IS_ERR(temp_dev))
		device_unregister(temp_dev);
	if (!IS_ERR(apu_dev))
		device_unregister(apu_dev);
	/* The devices are gone, so no duty can be written any more: give the fans back. */
	for (fan = ec_fans; fan < ec_fans + ARRAY_SIZE(ec_fans); fan++)
		if (fan->duty_reg && write_duty_verified(fan, 0))
			pr_err("ec_su_axb35: %s: not released to the firmware\n", fan->name);
	class_destroy(ec_class);
}

static int __init ec_su_axb35_init(void)
{
	struct ec_fan *fan;
	bool failed = false;

	/* The register addresses are those of this board with this firmware. */
	if (!dmi_match(DMI_BOARD_NAME, "AXB35-02") || !dmi_match(DMI_SYS_VENDOR, "BOSGAME LIMITED") ||
	    !dmi_match(DMI_PRODUCT_NAME, "BeyondMax Series") || !dmi_match(DMI_BIOS_VERSION, "3.11")) {
		pr_err("ec_su_axb35: not the tested machine (Bosgame M5, board AXB35-02, BIOS 3.11)\n");
		return -ENODEV;
	}
	ec_class = class_create("ec_su_axb35");
	if (IS_ERR(ec_class))
		return PTR_ERR(ec_class);
	for (fan = ec_fans; fan < ec_fans + ARRAY_SIZE(ec_fans); fan++) {
		fan->dev = device_create_with_groups(ec_class, NULL, MKDEV(0, 0), fan,
						     fan->duty_reg ? duty_fan_groups : fan_groups, "%s", fan->name);
		failed |= IS_ERR(fan->dev);
	}
	temp_dev = device_create_with_groups(ec_class, NULL, MKDEV(0, 0), NULL, temp_groups, "temp1");
	apu_dev = device_create_with_groups(ec_class, NULL, MKDEV(0, 0), NULL, apu_groups, "apu");
	if (failed || IS_ERR(temp_dev) || IS_ERR(apu_dev)) {
		ec_su_axb35_remove();
		return -ENODEV;
	}
	schedule_delayed_work(&duty_work, HZ);
	return 0;
}

module_init(ec_su_axb35_init);
module_exit(ec_su_axb35_remove);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("loom@mopper.de");
MODULE_DESCRIPTION("Sixunited AXB35-02 embedded controller: fans, temperature, power profile");
