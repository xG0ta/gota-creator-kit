"""Crea codigos de regalo para las pruebas locales.

Ejemplo:
    python -m service.create_gift_code --months 12 --uses 1
"""

import argparse

from service.licensing import default_store


def main():
    parser = argparse.ArgumentParser(description="Crear un codigo de regalo")
    parser.add_argument("--months", type=int, required=True)
    parser.add_argument("--uses", type=int, default=1)
    parser.add_argument("--expires-in-days", type=int, default=30)
    parser.add_argument("--label", default="Regalo creado por Gota")
    arguments = parser.parse_args()
    code = default_store().create_gift_code(
        duration_days=arguments.months * 30,
        max_redemptions=arguments.uses,
        expires_in_days=arguments.expires_in_days,
        label=arguments.label,
    )
    print(code)


if __name__ == "__main__":
    main()
