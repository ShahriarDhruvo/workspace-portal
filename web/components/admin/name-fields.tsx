import { NAME_MAX_LENGTH } from "@/lib/limits";
import { FormField } from "@/components/forms/form-field";

interface NameFieldsProps {
  values?: { firstName?: string; middleName?: string | null; lastName?: string };
  errors: Partial<Record<string, string>>;
  /** Focus the first name on arrival (the new-user form). */
  autoFocus?: boolean;
}

/** First, middle (optional) and last name side by side (stacked on narrow screens), as on the new-user and profile forms. */
export function NameFields({ values, errors, autoFocus }: NameFieldsProps) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-3">
      <FormField
        label="First name"
        name="firstName"
        placeholder="Ada"
        required
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        autoFocus={autoFocus}
        defaultValue={values?.firstName}
        error={errors.firstName}
      />
      <FormField
        label="Middle name"
        name="middleName"
        placeholder="Augusta"
        optional
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        defaultValue={values?.middleName ?? undefined}
        error={errors.middleName}
      />
      <FormField
        label="Last name"
        name="lastName"
        placeholder="Lovelace"
        required
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        defaultValue={values?.lastName}
        error={errors.lastName}
      />
    </div>
  );
}
