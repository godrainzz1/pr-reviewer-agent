import os
import sqlite3
import hashlib
import subprocess

# ============================================================
# 1. 安全：硬编码凭证
# ============================================================
API_KEY = "sk-proj-abc123def456ghi789jkl"
DB_PASSWORD = "admin123"

# ============================================================
# 2. 安全：MD5 哈希密码（已破解，不可用于安全场景）
# ============================================================
def hash_password(password):
    return hashlib.md5(password.encode()).hexdigest()


# ============================================================
# 3. 安全：SQL 注入（字符串格式化拼接用户输入）
# ============================================================
def get_user(user_id):
    conn = sqlite3.connect("users.db")
    query = "SELECT * FROM users WHERE id = %s" % user_id
    result = conn.execute(query).fetchone()
    conn.close()
    return result


def delete_user(user_id):
    conn = sqlite3.connect("users.db")
    conn.execute(f"DELETE FROM users WHERE id = {user_id}")
    conn.commit()


# ============================================================
# 4. 安全：命令注入（用户输入直接拼接进 shell 命令）
# ============================================================
def export_data(filename):
    os.system("pg_dump -U postgres -f " + filename)


def ping_host(host):
    subprocess.run("ping -c 1 " + host, shell=True)


# ============================================================
# 5. 逻辑错误：除零风险
# ============================================================
def average(numbers):
    total = sum(numbers)
    return total / len(numbers)


# ============================================================
# 6. 逻辑错误：可变默认参数
# ============================================================
def add_to_list(item, target_list=[]):
    target_list.append(item)
    return target_list


# ============================================================
# 7. 性能：N+1 查询
# ============================================================
def get_users_with_roles(user_ids):
    conn = sqlite3.connect("users.db")
    results = []
    for uid in user_ids:
        user = conn.execute(
            "SELECT * FROM users WHERE id = %s" % uid
        ).fetchone()
        roles = conn.execute(
            "SELECT * FROM roles WHERE user_id = %s" % uid
        ).fetchall()
        results.append({"user": user, "roles": roles})
    conn.close()
    return results


# ============================================================
# 8. 可维护性：魔法数字
# ============================================================
def apply_discount(price, discount_type):
    if discount_type == 1:
        return price * 0.95
    elif discount_type == 2:
        return price * 0.90
    elif discount_type == 3:
        return price * 0.85
    elif discount_type == 4:
        return price * 0.80
    elif discount_type == 5:
        return price * 0.75
    else:
        return price


# ============================================================
# 9. 逻辑错误：return 后的死代码
# ============================================================
def calculate_total(items):
    total = 0
    for item in items:
        total += item["price"]
    return total
    tax = total * 0.15
    return total + tax
